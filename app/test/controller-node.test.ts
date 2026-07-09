// Controller THREAD NODE coverage (controller-node-and-fifo-edges §3). The node
// absorbs `startActuationLoop`'s device lifecycle as a PUSH model and adds
// trigger-mode fovea pairing. Concerns:
//   (1) POSITION LIFECYCLE (v2) — createStream on first update, stream.update on
//       subsequent, terminate on close; enable-iff-we-enabled ownership; a
//       controller swap drops the stale stream and reopens; multi-input → one
//       MCU stream each.
//   (2) update() returns predictVolts synchronously + records mirror history ONCE.
//   (3) v1 FALLBACK — no CMD_STREAM; the node's paced loop awaits actuate() and
//       fires onApplied.
//   (4) WIRING — an input with `from` registers a `from → controller` edge that
//       the topology fold renders on the declared `controller` node; close
//       retires it.
//   (5) TRIGGER MATCHING — synthetic descriptors + FIN outcomes emit pairs within
//       tolerance and drop the unmatched (scheduler.ts + sync.ts composed).
//
// No serial hardware / addon: the node takes injected fake controllers + fake
// FrameTap seams (type-only `Controller`/`FrameOutcome` imports are erased).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControllerNode,
  controllerNode,
  resetControllerNodeForTest,
  type FrameDescriptor,
} from "@orchestrator/controller-node";
import {
  buildTopology,
  resetTopologyStateForTest,
} from "@orchestrator/graph-topology";
import { mirrorHistory } from "@orchestrator/mirror-history";
import type { FrameOutcome } from "@orchestrator/controller";

type Pos = { x: number; y: number };
const P = (x: number, y: number): Pos => ({ x, y });
const PAIR = (l: Pos, r: Pos) => ({ left: l, right: r });
const ORIGIN = PAIR(P(0, 0), P(0, 0));
/** Yield to the node's async stream-create / v1-loop macrotasks. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- fakes -------------------------------------------------------------------

function makeV2Controller() {
  const handles: Array<{ id: number; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const c = {
    port: "/dev/v2",
    v2Capable: true,
    connected: true,
    enabled: false,
    pos: PAIR(P(0, 0), P(0, 0)),
    enable: vi.fn(async () => {
      c.enabled = true;
    }),
    disable: vi.fn(async () => {
      c.enabled = false;
    }),
    predictVolts: vi.fn((p: { left: Pos; right: Pos }) => PAIR({ ...p.left }, { ...p.right })),
    createStream: vi.fn(async (_initial: { left: Pos; right: Pos }) => {
      const h = { id: handles.length, update: vi.fn(), close: vi.fn(async () => {}) };
      handles.push(h);
      return h;
    }),
    actuate: vi.fn(async (p: { left: Pos; right: Pos }) => ({ ...p })),
    handles,
  };
  return c;
}

function makeV1Controller() {
  const c = {
    port: "/dev/v1",
    v2Capable: false,
    connected: true,
    enabled: false,
    pos: PAIR(P(0, 0), P(0, 0)),
    enable: vi.fn(async () => {
      c.enabled = true;
    }),
    disable: vi.fn(async () => {
      c.enabled = false;
    }),
    predictVolts: vi.fn((p: { left: Pos; right: Pos }) => PAIR({ ...p.left }, { ...p.right })),
    createStream: vi.fn(),
    actuate: vi.fn(async (p: { left: Pos; right: Pos }) => {
      c.pos = PAIR({ ...p.left }, { ...p.right });
      return { ...c.pos };
    }),
  };
  return c;
}

let node: ControllerNode | null = null;

afterEach(() => {
  node?.dispose();
  node = null;
  resetControllerNodeForTest();
  resetTopologyStateForTest();
  vi.restoreAllMocks();
});

// --- (1) position lifecycle (v2) --------------------------------------------

describe("ControllerNode — position stream lifecycle (v2)", () => {
  it("creates the MCU stream on first update, streams subsequent, terminates + disables on close", async () => {
    node = new ControllerNode();
    const c = makeV2Controller();
    node.bindController(c as never);
    const input = node.openPosition("a", { initial: ORIGIN });

    input.update(PAIR(P(1, 1), P(2, 2)));
    await tick();
    expect(c.enable).toHaveBeenCalled(); // enabled it (was disabled) → enabledByUs
    expect(c.createStream).toHaveBeenCalledTimes(1); // created once at the pushed pose

    input.update(PAIR(P(3, 3), P(4, 4)));
    expect(c.handles[0]!.update).toHaveBeenCalledTimes(1); // subsequent updates stream

    await input.close();
    expect(c.handles[0]!.close).toHaveBeenCalledTimes(1); // MCU stream terminated
    expect(c.disable).toHaveBeenCalledTimes(1); // last close disabled (we enabled it)
  });

  it("does NOT disable a controller the caller pre-enabled (enable-iff-we-enabled)", async () => {
    node = new ControllerNode();
    const c = makeV2Controller();
    c.enabled = true; // user enabled it via the title bar
    node.bindController(c as never);
    const input = node.openPosition("a", { initial: ORIGIN });
    input.update(PAIR(P(1, 1), P(2, 2)));
    await tick();
    expect(c.enable).not.toHaveBeenCalled();
    await input.close();
    expect(c.disable).not.toHaveBeenCalled();
  });

  it("drops the stale stream and reopens on a controller swap", async () => {
    node = new ControllerNode();
    const c1 = makeV2Controller();
    node.bindController(c1 as never);
    const input = node.openPosition("a", { initial: ORIGIN });
    input.update(PAIR(P(1, 1), P(1, 1)));
    await tick();
    expect(c1.createStream).toHaveBeenCalledTimes(1);

    const c2 = makeV2Controller(); // fresh device = reconnect
    node.bindController(c2 as never);
    input.update(PAIR(P(2, 2), P(2, 2)));
    await tick();
    expect(c1.handles[0]!.close).toHaveBeenCalledTimes(1); // stale terminated
    expect(c2.createStream).toHaveBeenCalledTimes(1); // reopened on the new device

    await input.close();
  });

  it("unbindController drops every open stream (no disable — session/janitor owns that)", async () => {
    node = new ControllerNode();
    const c = makeV2Controller();
    node.bindController(c as never);
    const input = node.openPosition("a", { initial: ORIGIN });
    input.update(PAIR(P(1, 1), P(1, 1)));
    await tick();

    await node.unbindController();
    expect(c.handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(c.disable).not.toHaveBeenCalled(); // the node never disables on unbind

    await input.close();
  });

  it("maps each open position input to its own MCU stream", async () => {
    node = new ControllerNode();
    const c = makeV2Controller();
    node.bindController(c as never);
    const a = node.openPosition("a", { initial: ORIGIN });
    const b = node.openPosition("b", { initial: ORIGIN });
    a.update(PAIR(P(1, 1), P(1, 1)));
    b.update(PAIR(P(2, 2), P(2, 2)));
    await tick();
    expect(c.createStream).toHaveBeenCalledTimes(2);
    expect(c.handles[0]!.id).not.toBe(c.handles[1]!.id);

    await a.close();
    await b.close();
  });
});

// --- (2) update() return + mirror history ------------------------------------

describe("ControllerNode — update() return + trajectory record", () => {
  it("returns predictVolts synchronously and records mirror history ONCE", () => {
    node = new ControllerNode();
    const c = makeV2Controller();
    const spy = vi.spyOn(mirrorHistory, "record");
    node.bindController(c as never);
    const input = node.openPosition("a", { initial: ORIGIN });

    const predicted = input.update(PAIR(P(1.5, -2.3), P(0.7, 4.1)));
    expect(predicted).toEqual(PAIR(P(1.5, -2.3), P(0.7, 4.1))); // fake predict = identity
    expect(c.predictVolts).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(BigInt), P(1.5, -2.3), P(0.7, 4.1));
  });

  it("holds the last value (and records nothing) with no controller bound", () => {
    node = new ControllerNode();
    const spy = vi.spyOn(mirrorHistory, "record");
    const input = node.openPosition("a", { initial: PAIR(P(9, 9), P(8, 8)) });
    const out = input.update(PAIR(P(1, 1), P(2, 2)));
    expect(out).toEqual(PAIR(P(9, 9), P(8, 8))); // no device → mirror holds
    expect(spy).not.toHaveBeenCalled();
  });
});

// --- (3) v1 fallback ---------------------------------------------------------

describe("ControllerNode — v1 firmware fallback", () => {
  it("runs the paced actuate loop (no CMD_STREAM) and fires onApplied", async () => {
    node = new ControllerNode();
    const c = makeV1Controller();
    node.bindController(c as never);
    const onApplied = vi.fn();
    const input = node.openPosition("a", { initial: ORIGIN, onApplied });

    input.update(PAIR(P(1, 1), P(2, 2)));
    await wait(5); // let the 1 ms loop tick
    expect(c.createStream).not.toHaveBeenCalled();
    expect(c.actuate).toHaveBeenCalled();
    expect(c.enable).toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledWith({ L: P(1, 1), R: P(2, 2) }, expect.any(Number));

    await input.close();
    const count = c.actuate.mock.calls.length;
    await wait(5);
    expect(c.actuate.mock.calls.length).toBe(count); // loop stopped on last close
  });
});

// --- (4) wiring registration / retirement ------------------------------------

describe("ControllerNode — graph wiring", () => {
  it("declares the `controller` node and registers/retires the input edge", async () => {
    resetTopologyStateForTest();
    const n = controllerNode(); // singleton (registers its wiring at creation)
    const input = n.openPosition("track", { from: "camera/X/kcf", initial: ORIGIN });

    let topo = buildTopology({ listPipes: () => [], workloads: () => ({}), now: () => 0 });
    expect(topo.nodes.find((x) => x.id === "controller")).toMatchObject({
      kind: "controller",
      transport: "native",
    });
    expect(topo.edges).toContainEqual(
      expect.objectContaining({ from: "camera/X/kcf", to: "controller", port: "track" }),
    );

    await input.close();
    topo = buildTopology({ listPipes: () => [], workloads: () => ({}), now: () => 0 });
    expect(topo.edges.find((e) => e.to === "controller" && e.port === "track")).toBeUndefined();
    resetControllerNodeForTest();
  });
});

// --- (5) trigger-mode pair matching ------------------------------------------

function frameOutcome(tExposure: bigint, stream = 0): FrameOutcome {
  return {
    frameId: 1,
    stream,
    tTrigger: tExposure - 100n,
    tExposure,
    left: P(0, 0),
    right: P(0, 0),
  };
}

/** A fake requester resolving every CMD_FRAME immediately with `outcome`. */
function fakeFrameController(outcome: FrameOutcome) {
  return {
    port: "/dev/t",
    v2Capable: true,
    connected: true,
    frame: vi.fn(() =>
      Object.assign(Promise.resolve(outcome), { accepted: Promise.resolve() }),
    ),
  };
}

describe("ControllerNode — trigger-mode pair matching", () => {
  it("emits a pair when both sides fall within tolerance of the FIN exposure", async () => {
    node = new ControllerNode();
    const c = fakeFrameController(frameOutcome(1_002_000n));
    node.bindController(c as never);

    let pushL: (d: FrameDescriptor) => void = () => {};
    let pushR: (d: FrameDescriptor) => void = () => {};
    node.bindFoveaCameras({
      left: { nodeId: "camera/L", subscribe: (cb) => ((pushL = cb), () => {}) },
      right: { nodeId: "camera/R", subscribe: (cb) => ((pushR = cb), () => {}) },
    });
    const pairs: Array<{ left: FrameDescriptor; right: FrameDescriptor; stream: number }> = [];
    node.onPair((p) => pairs.push(p));

    pushL({ deviceTimestamp: 1_000_000n });
    pushR({ deviceTimestamp: 1_005_000n });

    const cap = node.startTriggerCapture({
      targets: [{ stream: 0 }],
      toleranceNs: 8_000_000n,
      scheduler: { maxInFlight: 1, defaultMinIntervalMs: 1000, acceptedTimeoutMs: 0, completionTimeoutMs: 0 },
    });
    await tick();
    cap.stop();

    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0]!.left.deviceTimestamp).toBe(1_000_000n);
    expect(pairs[0]!.right.deviceTimestamp).toBe(1_005_000n);
    expect(pairs[0]!.stream).toBe(0);
  });

  it("drops the FIN when a side has no descriptor within tolerance", async () => {
    node = new ControllerNode();
    const c = fakeFrameController(frameOutcome(1_002_000n));
    node.bindController(c as never);

    let pushL: (d: FrameDescriptor) => void = () => {};
    let pushR: (d: FrameDescriptor) => void = () => {};
    node.bindFoveaCameras({
      left: { nodeId: "camera/L", subscribe: (cb) => ((pushL = cb), () => {}) },
      right: { nodeId: "camera/R", subscribe: (cb) => ((pushR = cb), () => {}) },
    });
    const pairs: unknown[] = [];
    node.onPair((p) => pairs.push(p));

    pushL({ deviceTimestamp: 1_000_000n });
    pushR({ deviceTimestamp: 50_000_000n }); // far outside the 8 ms window

    const cap = node.startTriggerCapture({
      targets: [{ stream: 0 }],
      toleranceNs: 8_000_000n,
      scheduler: { maxInFlight: 1, defaultMinIntervalMs: 1000, acceptedTimeoutMs: 0, completionTimeoutMs: 0 },
    });
    await tick();
    cap.stop();

    expect(pairs.length).toBe(0); // unmatched → dropped
  });
});
