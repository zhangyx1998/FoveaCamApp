// PID node infrastructure (docs/proposals/pid-nodes-and-view-replumb.md
// §"PID node design (worker A)"): the reusable PID parameter shape + PID-2D
// variant (`@lib/pid`), the graph-visible controller node with the ruled
// override slot (`@orchestrator/pid-node`), and the module-agnostic override
// contract fragment (`@lib/orchestrator/pid-override-contract`).
//
// All pure — no native `core` addon (only `@lib/pid`'s `clamp` + type-only
// `Point2d`), so unlike `vergence.test.ts` this needs no `core/Vision` mock.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { PID, PID2D } from "@lib/pid";
import {
  applyPidOverride,
  createPidNode,
  isOverrideHeld,
  outputOf,
} from "@orchestrator/pid-node";
import {
  buildTopology,
  resetTopologyStateForTest,
} from "@orchestrator/graph-topology";
import { pidOverrideState } from "@lib/orchestrator/pid-override-contract";

// --- PID.setParams -----------------------------------------------------------

describe("PID.setParams (uniform PidParams, live retune)", () => {
  it("updates gains without disturbing the running integrator/derivative", () => {
    const pid = new PID({ kp: 1, ki: 1, kd: 0, limits: [-10, 10] });
    pid.step(2, 1); // integral now 2
    expect(pid.value).toBe(2);
    pid.setParams({ kp: 5, ki: 3, kd: 1 });
    expect(pid.kp).toBe(5);
    expect(pid.ki).toBe(3);
    expect(pid.kd).toBe(1);
    // Integrator survived the retune (loop keeps running through the change).
    expect(pid.value).toBe(2);
  });

  it("re-clamps the live integrator when limits tighten", () => {
    const pid = new PID({ kp: 0, ki: 1, kd: 0, limits: [-100, 100] });
    pid.step(80, 1); // integral 80
    expect(pid.value).toBe(80);
    // A tightened output bound re-derives the integral clamp and re-clamps now.
    pid.setParams({ kp: 0, ki: 1, kd: 0, limits: [-50, 50] });
    expect(pid.integralLimits).toEqual([-50, 50]);
    expect(pid.value).toBe(50);
  });

  it("leaves limits untouched when params omit them (gain-only retune)", () => {
    const pid = new PID({ kp: 1, ki: 1, kd: 0, limits: [-7, 7] });
    pid.setParams({ kp: 2, ki: 2, kd: 0 });
    expect(pid.limits).toEqual([-7, 7]);
    expect(pid.integralLimits).toEqual([-7, 7]);
  });
});

// --- PID2D -------------------------------------------------------------------

describe("PID2D (2D variant, independent per-axis params)", () => {
  it("steps each axis on its own PidParams", () => {
    const pid = new PID2D({
      x: { kp: 0, ki: 1, kd: 0, limits: [-100, 100] },
      y: { kp: 0, ki: 2, kd: 0, limits: [-100, 100] },
    });
    const out = pid.step({ x: 3, y: 3 }, 1);
    // velocity form: integral += ki·e·dt → x: 1·3 = 3, y: 2·3 = 6.
    expect(out).toEqual({ x: 3, y: 6 });
    expect(pid.value).toEqual({ x: 3, y: 6 });
  });

  it("saturates each axis to its own limits", () => {
    const pid = new PID2D({
      x: { kp: 0, ki: 1, kd: 0, limits: [-2, 2] },
      y: { kp: 0, ki: 1, kd: 0, limits: [-50, 50] },
    });
    pid.step({ x: 10, y: 10 }, 1);
    expect(pid.value).toEqual({ x: 2, y: 10 }); // x clamped, y not
  });

  it("value getter/setter round-trips a point", () => {
    const pid = new PID2D({
      x: { kp: 0, ki: 1, kd: 0, limits: [-100, 100] },
      y: { kp: 0, ki: 1, kd: 0, limits: [-100, 100] },
    });
    pid.value = { x: 12, y: -8 };
    expect(pid.value).toEqual({ x: 12, y: -8 });
  });

  it("reset(point) seeds both axes; reset() zeroes them", () => {
    const pid = new PID2D({
      x: { kp: 0, ki: 1, kd: 0, limits: [-100, 100] },
      y: { kp: 0, ki: 1, kd: 0, limits: [-100, 100] },
    });
    pid.step({ x: 5, y: 5 }, 1);
    pid.reset({ x: 4, y: -4 });
    expect(pid.value).toEqual({ x: 4, y: -4 });
    pid.reset();
    expect(pid.value).toEqual({ x: 0, y: 0 });
  });

  it("setParams retunes one axis and leaves the other untouched", () => {
    const pid = new PID2D({
      x: { kp: 1, ki: 1, kd: 0 },
      y: { kp: 1, ki: 1, kd: 0 },
    });
    pid.setParams({ x: { kp: 9, ki: 9, kd: 9 } });
    expect(pid.x.kp).toBe(9);
    expect(pid.y.kp).toBe(1); // omitted axis unchanged
  });
});

// --- PID node override semantics ---------------------------------------------

type Volts = { l: number; r: number };

function makeNode(seed?: (v: Volts) => void) {
  const pan = new PID2D({
    x: { kp: 0, ki: 1, kd: 0, limits: [-100, 100] },
    y: { kp: 0, ki: 1, kd: 0, limits: [-100, 100] },
  });
  const verge = new PID({ kp: 0, ki: 1, kd: 0, limits: [-100, 100] });
  const node = createPidNode<Volts>({
    id: "win/pid-test/pid",
    kind: "pid",
    owner: "win/pid-test",
    inputs: [{ from: "win/pid-test/scope", port: "in" }],
    outputs: [{ to: "controller/dev/tty", port: "cmd" }],
    controllers: { pan, verge },
    seed,
  });
  return { node, pan, verge };
}

describe("createPidNode — override slot (RULED semantics)", () => {
  beforeEach(resetTopologyStateForTest);

  it("runs the control fn and returns its result when NOT engaged", () => {
    const { node } = makeNode();
    const fn = vi.fn<[], Volts>(() => ({ l: 1, r: 2 }));
    const r = node.step(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isOverrideHeld(r)).toBe(false);
    expect(outputOf(r)).toEqual({ l: 1, r: 2 });
    node.dispose();
  });

  it("while ENGAGED: skips the control fn, resets ALL controllers each tick, outputs the override", () => {
    const { node, pan, verge } = makeNode();
    // Wind up the controllers so the reset is observable.
    pan.value = { x: 30, y: -30 };
    verge.value = 42;
    node.override.engage({ l: 5, r: -5 });
    expect(node.override.engaged).toBe(true);
    expect(node.override.value).toEqual({ l: 5, r: -5 });

    const fn = vi.fn<[], Volts>(() => {
      throw new Error("control fn must not run while overridden");
    });
    const r1 = node.step(fn);
    expect(fn).not.toHaveBeenCalled();
    expect(isOverrideHeld(r1)).toBe(true);
    expect(outputOf(r1)).toEqual({ l: 5, r: -5 });
    // All named controllers held at zero this tick.
    expect(pan.value).toEqual({ x: 0, y: 0 });
    expect(verge.value).toBe(0);

    // "each tick": re-wind between ticks, step again, still reset to zero.
    pan.value = { x: 9, y: 9 };
    verge.value = 9;
    node.step(fn);
    expect(pan.value).toEqual({ x: 0, y: 0 });
    expect(verge.value).toBe(0);
    node.dispose();
  });

  it("update() moves the pinned value without releasing (idempotent engage)", () => {
    const { node } = makeNode();
    node.override.engage({ l: 1, r: 1 });
    node.override.update({ l: 7, r: 8 });
    expect(node.override.engaged).toBe(true);
    expect(outputOf(node.step(() => ({ l: 0, r: 0 })))).toEqual({ l: 7, r: 8 });
    node.dispose();
  });

  it("release() seeds with the LAST override value and resumes the control fn", () => {
    const seed = vi.fn<[Volts], void>();
    const { node } = makeNode(seed);
    node.override.engage({ l: 3, r: 4 });
    node.override.update({ l: 11, r: 12 }); // last override
    node.override.release();

    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledWith({ l: 11, r: 12 });
    expect(node.override.engaged).toBe(false);
    expect(node.override.value).toBeNull();

    // Control fn runs again after release.
    const fn = vi.fn<[], Volts>(() => ({ l: 99, r: 99 }));
    const r = node.step(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(outputOf(r)).toEqual({ l: 99, r: 99 });
    node.dispose();
  });

  it("release() is a no-op (no seed) when not engaged", () => {
    const seed = vi.fn<[Volts], void>();
    const { node } = makeNode(seed);
    node.override.release();
    expect(seed).not.toHaveBeenCalled();
    node.dispose();
  });
});

// --- graph wiring / report shape ---------------------------------------------

describe("createPidNode — graph wiring registration", () => {
  beforeEach(resetTopologyStateForTest);

  it("report() carries the node identity + INCOMING edges only", () => {
    const { node } = makeNode();
    const report = node.report();
    expect(report).toMatchObject({
      id: "win/pid-test/pid",
      kind: "pid",
      transport: "native",
      owner: "win/pid-test",
      output: { kind: "analysis", schema: "pid" },
    });
    // Only the scope→pid input; the pid→controller edge is the controller's
    // input (edge ownership by the consumer).
    expect(report.inputs).toEqual([
      {
        from: "win/pid-test/scope",
        port: "in",
        type: { kind: "analysis", schema: "pid" },
      },
    ]);
    node.dispose();
  });

  it("registers the pid node + scope→pid and pid→controller edges in the topology", () => {
    const { node } = makeNode();
    const topo = buildTopology({
      listPipes: () => [],
      workloads: () => ({}),
      now: () => 0,
    });
    const pid = topo.nodes.find((n) => n.id === "win/pid-test/pid");
    expect(pid).toMatchObject({ kind: "pid", owner: "win/pid-test", transport: "native" });
    expect(topo.edges).toContainEqual(
      expect.objectContaining({ from: "win/pid-test/scope", to: "win/pid-test/pid", port: "in" }),
    );
    expect(topo.edges).toContainEqual(
      expect.objectContaining({ from: "win/pid-test/pid", to: "controller/dev/tty", port: "cmd" }),
    );
    node.dispose();
  });

  it("dispose() retires the wiring — the node disappears from the topology", () => {
    const { node } = makeNode();
    node.dispose();
    const topo = buildTopology({
      listPipes: () => [],
      workloads: () => ({}),
      now: () => 0,
    });
    expect(topo.nodes.find((n) => n.id === "win/pid-test/pid")).toBeUndefined();
  });
});

// --- override contract fragment (reusable across modules) --------------------

describe("pid-override contract fragment", () => {
  it("pidOverrideState() defaults to released", () => {
    expect(pidOverrideState<Volts>()).toEqual({ engaged: false, value: null });
  });

  it("applyPidOverride maps {value} → engage and returns the mirrored state", () => {
    const { node } = makeNode();
    resetTopologyStateForTest();
    const state = applyPidOverride(node.override, { value: { l: 2, r: 3 } });
    expect(node.override.engaged).toBe(true);
    expect(state).toEqual({ engaged: true, value: { l: 2, r: 3 } });
    node.dispose();
  });

  it("applyPidOverride maps {release:true} → release and returns released state", () => {
    const seed = vi.fn<[Volts], void>();
    const { node } = makeNode(seed);
    resetTopologyStateForTest();
    node.override.engage({ l: 5, r: 6 });
    const state = applyPidOverride(node.override, { release: true });
    expect(seed).toHaveBeenCalledWith({ l: 5, r: 6 });
    expect(state).toEqual({ engaged: false, value: null });
    node.dispose();
  });
});
