// Coverage for the marker servo's PID-node control core (marker-tracker.ts
// `startServo`), rebuilt on the landed PID infra (docs/proposals/pid-nodes-and-
// view-replumb.md). Three concerns:
//   (1) NUMERIC EQUIVALENCE — the PID2D velocity-form step (ki = kp, kp = kd = 0)
//       reproduces the original hand-rolled `pos += rel*kp`, and the no-marker
//       branch reproduces the overshoot-guarded `backToCenter` return-to-origin.
//   (2) OVERRIDE — the ruled slot through the servo: while a per-eye override is
//       held the control law is skipped and the output is pinned; on release the
//       servo resumes FROM the released pose (no snap-back).
//   (3) GRAPH WIRING — each eye registers a `pid` node + its detect→pid and
//       pid→controller edges; `stop()` retires them.
//
// The native controller module is mocked to a settable holder (no serial
// hardware); `core/*` value imports pulled in transitively by `marker-tracker`
// (via `@lib/marker`) are stubbed so importing it needs no addon. The servo runs
// against structural fake trackers (same pattern as `marker-calibration.test`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";

// core/* stubs (marker-tracker → @lib/marker imports these at module eval; the
// servo never calls any of them — they exist only to keep the addon out).
vi.mock("core/Vision", () => ({
  MarkerDetector: class {},
  Projector: class {},
  Mat: class {},
  cornerSubPix: vi.fn(),
  findHomography: vi.fn(),
  projectHomography: vi.fn(),
  gaussian: vi.fn(),
}));
vi.mock("core/Geometry", () => ({ area: vi.fn() }));
vi.mock("core/Regression", () => ({ default: class {}, RegressionConfig: class {} }));

// A settable active-controller holder standing in for the shared MEMS device.
const { holder } = vi.hoisted(() => ({ holder: { c: null as FakeController | null } }));
vi.mock("@orchestrator/controller", () => ({
  activeController: () => holder.c,
  setActiveController: (c: FakeController | null) => {
    holder.c = c;
  },
}));

import { startServo, type MarkerTracker } from "@orchestrator/marker-tracker";
import {
  buildTopology,
  resetTopologyStateForTest,
} from "@orchestrator/graph-topology";

// --- fakes -------------------------------------------------------------------

class FakeController {
  enabled = true; // pre-enabled: skip the servo's enable+origin actuate
  pos: { left: Pos; right: Pos } = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  actuated: Array<{ left?: Pos; right?: Pos }> = [];
  async enable() {
    this.enabled = true;
  }
  async disable() {
    this.enabled = false;
  }
  async actuate(p: { left?: Pos; right?: Pos }) {
    this.actuated.push({
      ...(p.left ? { left: { ...p.left } } : {}),
      ...(p.right ? { right: { ...p.right } } : {}),
    });
    if (p.left) this.pos.left = { ...p.left };
    if (p.right) this.pos.right = { ...p.right };
    return { ...this.pos };
  }
  last() {
    return this.actuated[this.actuated.length - 1];
  }
}

interface FakeTracker {
  serial: string;
  rel: Point2d | null;
  centerRelative: Point2d | null;
  onDetection(fn: () => void): () => void;
  fire(): void;
  stop(): void;
}

function fakeTracker(serial: string): FakeTracker {
  const handlers = new Set<() => void>();
  const t: FakeTracker = {
    serial,
    rel: null,
    get centerRelative() {
      return t.rel;
    },
    onDetection(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    fire() {
      for (const h of [...handlers]) h();
    },
    stop() {},
  };
  return t;
}

const asTracker = (t: FakeTracker): MarkerTracker => t as unknown as MarkerTracker;
/** Let the async actuation loop pick up a fired detection's `pending` command. */
const settle = () => new Promise<void>((r) => setTimeout(r, 25));

beforeEach(() => {
  resetTopologyStateForTest();
  holder.c = new FakeController();
});
afterEach(() => {
  holder.c = null;
});

// --- (1) numeric equivalence -------------------------------------------------

describe("marker servo — numeric equivalence with the original proportional update", () => {
  it("marker branch reproduces `pos += rel*kp` (default kp=16) across a sequence", async () => {
    const c = holder.c!;
    c.pos.left = { x: 1, y: 2 };
    const L = fakeTracker("SER-L");
    const servo = startServo(asTracker(L), undefined, {}); // kp defaults to 16.0

    L.rel = { x: 0.1, y: -0.2 };
    L.fire();
    await settle();
    // base {1,2} + rel*16 = {2.6, -1.2}
    expect(c.last()!.left!.x).toBeCloseTo(2.6, 10);
    expect(c.last()!.left!.y).toBeCloseTo(-1.2, 10);
    expect(c.last()!.right).toBeUndefined(); // no right tracker

    L.rel = { x: 0.05, y: 0.05 };
    L.fire();
    await settle();
    // base is now the live readback {2.6,-1.2} + rel*16 = {3.4, -0.4}
    expect(c.last()!.left!.x).toBeCloseTo(3.4, 10);
    expect(c.last()!.left!.y).toBeCloseTo(-0.4, 10);

    servo.stop();
  });

  it("no-marker branch reproduces the overshoot-guarded backToCenter return", async () => {
    const c = holder.c!;
    c.pos.left = { x: 5, y: -3 };
    const L = fakeTracker("SER-L");
    // kp=2 so the return step is a PARTIAL move (doesn't reach origin in one tick).
    const servo = startServo(asTracker(L), undefined, {
      kp: 2,
      originLeft: () => ({ x: 0, y: 0 }),
    });

    L.rel = null; // marker not visible → walk back toward origin
    L.fire();
    await settle();
    // x: 5 + backToCenter(5,2) = 5 - 2 = 3 ; y: -3 + backToCenter(-3,2) = -3 + 2 = -1
    expect(c.last()!.left!.x).toBeCloseTo(3, 10);
    expect(c.last()!.left!.y).toBeCloseTo(-1, 10);

    servo.stop();
  });
});

// --- (2) override semantics through the servo --------------------------------

describe("marker servo — ruled override slot (held pins output, release resumes from pose)", () => {
  it("while held: skips the control law and pins the output; on release: resumes from the released pose", async () => {
    const c = holder.c!;
    c.pos.left = { x: 0, y: 0 };
    const L = fakeTracker("SER-L");
    let ov: Pos | null = null;
    const servo = startServo(asTracker(L), undefined, {
      overrideLeft: () => ov,
      originLeft: () => ({ x: 0, y: 0 }),
    });

    // Engage: the marker is visible but must be IGNORED while overridden.
    ov = { x: 7, y: 8 };
    L.rel = { x: 0.1, y: 0.1 };
    L.fire();
    await settle();
    expect(c.last()!.left).toEqual({ x: 7, y: 8 }); // pinned, control fn skipped
    expect(servo.override.left!.engaged).toBe(true);

    // Still held, marker jumps — output stays pinned (control law not run).
    L.rel = { x: 0.5, y: 0.5 };
    L.fire();
    await settle();
    expect(c.last()!.left).toEqual({ x: 7, y: 8 });

    // Release: resume from the released pose {7,8}, NOT a snap toward origin.
    ov = null;
    L.rel = { x: 0.1, y: 0.1 };
    L.fire();
    await settle();
    expect(servo.override.left!.engaged).toBe(false);
    // base = live readback {7,8} + rel*16 = {8.6, 9.6} (would be ~{1.6,1.6} on a snap)
    expect(c.last()!.left!.x).toBeCloseTo(8.6, 10);
    expect(c.last()!.left!.y).toBeCloseTo(9.6, 10);

    servo.stop();
  });

  it("overriding ONE eye pins it while the other keeps servoing (per-eye grain)", async () => {
    const c = holder.c!;
    c.pos.left = { x: 0, y: 0 };
    c.pos.right = { x: 0, y: 0 };
    const L = fakeTracker("SER-L");
    const R = fakeTracker("SER-R");
    let ovL: Pos | null = null;
    const servo = startServo(asTracker(L), asTracker(R), {
      overrideLeft: () => ovL,
    });

    ovL = { x: 3, y: 3 }; // left pinned
    L.rel = { x: 0.9, y: 0.9 };
    R.rel = { x: 0.2, y: 0.2 };
    L.fire();
    R.fire();
    await settle();
    // left held at the override; right still servos `pos += rel*16`.
    expect(c.pos.left).toEqual({ x: 3, y: 3 });
    expect(c.pos.right.x).toBeCloseTo(3.2, 10);
    expect(c.pos.right.y).toBeCloseTo(3.2, 10);
    expect(servo.override.left!.engaged).toBe(true);
    expect(servo.override.right!.engaged).toBe(false);

    servo.stop();
  });
});

// --- (3) graph wiring registration -------------------------------------------

describe("marker servo — PID node graph wiring", () => {
  it("registers a `pid` node + detect→pid and pid→controller edges per eye", () => {
    const L = fakeTracker("SER-L");
    const R = fakeTracker("SER-R");
    const servo = startServo(asTracker(L), asTracker(R), { owner: "cal-x" });

    const topo = buildTopology({ listPipes: () => [], workloads: () => ({}), now: () => 0 });
    for (const side of ["left", "right"] as const) {
      const id = `win/cal-x/pid/${side}`;
      expect(topo.nodes.find((n) => n.id === id)).toMatchObject({
        kind: "pid",
        owner: "win/cal-x",
        transport: "native",
      });
    }
    expect(topo.edges).toContainEqual(
      expect.objectContaining({ from: "camera/SER-L/detect", to: "win/cal-x/pid/left", port: "marker" }),
    );
    expect(topo.edges).toContainEqual(
      expect.objectContaining({ from: "camera/SER-R/detect", to: "win/cal-x/pid/right", port: "marker" }),
    );
    expect(topo.edges).toContainEqual(
      expect.objectContaining({ from: "win/cal-x/pid/left", to: "controller", port: "left" }),
    );
    expect(topo.edges).toContainEqual(
      expect.objectContaining({ from: "win/cal-x/pid/right", to: "controller", port: "right" }),
    );

    servo.stop();
  });

  it("exposes per-eye node + override handles (null for an absent eye) and retires wiring on stop()", () => {
    const L = fakeTracker("SER-L");
    const servo = startServo(asTracker(L), undefined, { owner: "cal-y" });

    expect(servo.nodes.left).not.toBeNull();
    expect(servo.nodes.right).toBeNull();
    expect(servo.override.right).toBeNull();
    // The exposed override slot IS the node's own slot (what the follow-up drives).
    expect(servo.override.left).toBe(servo.nodes.left!.override);

    servo.stop();
    const topo = buildTopology({ listPipes: () => [], workloads: () => ({}), now: () => 0 });
    expect(topo.nodes.find((n) => n.id === "win/cal-y/pid/left")).toBeUndefined();
  });
});
