// MultiFoveaRuntime (C-24 step 4) — the SESSION-SIDE POLICY half over B-25's
// native multi-KCF thread: arm/disarm churn (slot index = target id, re-arm
// re-inits), lost tolerance over the batched `ok:false` results, steering as
// manual hold, controller-stream sync races (unchanged from the pre-port
// tests), and the composed-fovea rect steering. All deps faked — no core.

import { describe, expect, it, vi } from "vitest";
import type { Rect } from "core/Geometry";
import { MultiFoveaRuntime, type MultiFoveaRuntimeDeps } from "@modules/multi-fovea/runtime";
import { defaultMultiFoveaTarget } from "@modules/multi-fovea/contract";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

const batch = (
  targets: Array<{ id: string; ok: boolean; bbox: Rect | null; updateMs?: number }>,
) => ({
  seq: 1,
  targets: targets.map((t) => ({ updateMs: 1, ...t })),
});

function makeDeps(streams: Array<{ id: number; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>) {
  const armed: Array<[string, Rect]> = [];
  const disarmed: string[] = [];
  const rects: Array<[number, Rect]> = [];
  const schedulerTargets: Array<Array<{ stream: number }>> = [];
  let streamIndex = 0;
  const deps: MultiFoveaRuntimeDeps = {
    arm: vi.fn((id, roi) => armed.push([id, roi])),
    disarm: vi.fn((id) => disarmed.push(id)),
    async createStream() {
      return streams[streamIndex++] ?? null;
    },
    targetPose(_index, center) {
      return {
        angle: center,
        volt: { L: { x: center.x, y: center.y }, R: { x: -center.x, y: -center.y } },
      };
    },
    updateScheduler(targets) {
      schedulerTargets.push(targets);
    },
    publish: vi.fn(),
    updateFoveaRect: vi.fn((index, rect) => rects.push([index, rect])),
  };
  return { deps, armed, disarmed, rects, schedulerTargets };
}

const stream = (id: number) => ({ id, update: vi.fn(), close: vi.fn(async () => {}) });

function target(index: number, over: Partial<ReturnType<typeof defaultMultiFoveaTarget>> = {}) {
  const t = defaultMultiFoveaTarget(index);
  return { ...t, enabled: true, center: { x: 50, y: 50 }, ...over };
}

describe("MultiFoveaRuntime (batched multi-KCF)", () => {
  it("arms enabled slots at setTargets (clamped roi) and syncs one stream each", async () => {
    const streams = [stream(10), stream(11)];
    const { deps, armed, schedulerTargets, rects } = makeDeps(streams);
    const runtime = new MultiFoveaRuntime({ activeRequestCount: 0 }, deps);
    runtime.setFrameSize({ width: 100, height: 100 });

    runtime.setTargets([
      target(0, { tracker: { ...defaultMultiFoveaTarget(0).tracker, width: 10, height: 10 } }),
      target(1),
    ]);
    await flush();

    expect(armed.map(([id]) => id)).toEqual(["0", "1"]);
    expect(armed[0]![1]).toEqual({ x: 45, y: 45, width: 10, height: 10 });
    expect(schedulerTargets.at(-1)).toEqual([{ stream: 10 }, { stream: 11 }]);
    // The composed fovea crop follows the arm rect immediately.
    expect(rects[0]).toEqual([0, { x: 45, y: 45, width: 10, height: 10 }]);
  });

  it("re-arms (not disarm+arm) when a target's center changes — ruled re-init path", async () => {
    const { deps, armed, disarmed } = makeDeps([stream(30), stream(31)]);
    const runtime = new MultiFoveaRuntime({ activeRequestCount: 0 }, deps);
    runtime.setFrameSize({ width: 100, height: 100 });
    const t0 = target(0, { tracker: { ...defaultMultiFoveaTarget(0).tracker, width: 10, height: 10 } });
    runtime.setTargets([t0]);
    await flush();
    runtime.setTargets([{ ...t0, center: { x: 30, y: 40 } }]);
    await flush();

    expect(disarmed).toEqual([]); // arm on a live id re-inits natively
    expect(armed).toHaveLength(2);
    expect(armed[1]![1]).toEqual({ x: 25, y: 35, width: 10, height: 10 });
  });

  it("preset target: NOT KCF-armed, but gets a stream + fovea rect at the projected pixel (demo)", async () => {
    const s0 = stream(50);
    const { deps, armed, schedulerTargets, rects } = makeDeps([s0]);
    // Projection stub: the preset angle → a fixed wide pixel for the crop.
    deps.projectAngle = vi.fn(() => ({ x: 60, y: 40 }));
    const runtime = new MultiFoveaRuntime({ activeRequestCount: 0 }, deps);
    runtime.setFrameSize({ width: 100, height: 100 });

    runtime.setTargets([
      target(0, {
        preset: { pan: -5, tilt: -5 },
        tracker: { ...defaultMultiFoveaTarget(0).tracker, width: 10, height: 10 },
      }),
    ]);
    await flush();

    // No KCF arm for a preset — it is a STATIC angle-space target.
    expect(armed).toEqual([]);
    // Still round-robined (a stream is created + scheduled).
    expect(schedulerTargets.at(-1)).toEqual([{ stream: 50 }]);
    // Fovea crop centered on the projected pixel (deps.projectAngle), clamped.
    expect(deps.projectAngle).toHaveBeenCalled();
    expect(rects.at(-1)).toEqual([0, { x: 55, y: 35, width: 10, height: 10 }]);

    // A preset id never produces meaningful KCF results — a stray batch entry
    // for it is ignored (armed=false), so no pose/stream churn from tracking.
    s0.update.mockClear();
    runtime.onTrackResults(
      batch([{ id: "0", ok: true, bbox: { x: 0, y: 0, width: 4, height: 4 } }]),
    );
    expect(s0.update).not.toHaveBeenCalled();
  });

  it("consumes a batch: bbox → pose → stream.update → fovea rect; publish", async () => {
    const s0 = stream(41);
    const { deps, rects } = makeDeps([s0]);
    const runtime = new MultiFoveaRuntime({ activeRequestCount: 0 }, deps);
    runtime.setFrameSize({ width: 100, height: 100 });
    runtime.setTargets([target(0)]);
    await flush();

    const ms = runtime.onTrackResults(
      batch([{ id: "0", ok: true, bbox: { x: 10, y: 20, width: 8, height: 6 }, updateMs: 3 }]),
    );
    expect(ms).toBe(3);
    expect(s0.update).toHaveBeenLastCalledWith({
      left: { x: 14, y: 23 }, // bbox center
      right: { x: -14, y: -23 },
    });
    expect(rects.at(-1)).toEqual([0, { x: 10, y: 20, width: 8, height: 6 }]);
  });

  it("lost tolerance: ok:false accumulates; at tolerance the slot disarms + releases", async () => {
    const s0 = stream(42);
    const { deps, disarmed } = makeDeps([s0]);
    const runtime = new MultiFoveaRuntime({ activeRequestCount: 0 }, deps);
    runtime.setFrameSize({ width: 100, height: 100 });
    const tolerance = 3;
    runtime.setTargets([
      target(0, {
        tracker: { ...defaultMultiFoveaTarget(0).tracker, lostTolerance: tolerance },
      }),
    ]);
    await flush();

    for (let i = 0; i < tolerance - 1; i++)
      runtime.onTrackResults(batch([{ id: "0", ok: false, bbox: null }]));
    expect(disarmed).toEqual([]); // the thread emits ok:false liberally — absorbed
    runtime.onTrackResults(batch([{ id: "0", ok: false, bbox: null }]));
    expect(disarmed).toEqual(["0"]);
    expect(s0.close).toHaveBeenCalledTimes(1);
  });

  it("steering disarms into manual hold; later batches for that slot are ignored", async () => {
    const s0 = stream(43);
    const { deps, disarmed } = makeDeps([s0]);
    const publish = deps.publish as ReturnType<typeof vi.fn>;
    const runtime = new MultiFoveaRuntime({ activeRequestCount: 0 }, deps);
    runtime.setFrameSize({ width: 100, height: 100 });
    runtime.setTargets([
      target(0, { tracker: { ...defaultMultiFoveaTarget(0).tracker, width: 10, height: 10 } }),
    ]);
    await flush();

    runtime.steerTarget(0, { x: 60, y: 60 });
    expect(disarmed).toEqual(["0"]);
    expect(s0.update).toHaveBeenLastCalledWith({
      left: { x: 60, y: 60 },
      right: { x: -60, y: -60 },
    });

    // A late batch for the steered slot must not move it (manual hold).
    runtime.onTrackResults(
      batch([{ id: "0", ok: true, bbox: { x: 1, y: 2, width: 8, height: 6 } }]),
    );
    const last = publish.mock.calls.at(-1)?.[0]?.[0];
    expect(last.bbox).toEqual({ x: 55, y: 55, width: 10, height: 10 }); // steer rect, not the batch's
  });

  it("closes a stream handle that resolves after dispose", async () => {
    const pending = new Deferred<ReturnType<typeof stream>>();
    const { deps, schedulerTargets } = makeDeps([]);
    deps.createStream = () => pending.promise;
    const runtime = new MultiFoveaRuntime({ activeRequestCount: 0 }, deps);
    runtime.setFrameSize({ width: 100, height: 100 });
    runtime.setTargets([target(0)]);
    await flush();
    runtime.dispose();
    const stale = stream(8);
    pending.resolve(stale);
    await flush();

    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(schedulerTargets.at(-1)).toEqual([]);
  });

  it("reruns stream sync when targets change during an in-flight create", async () => {
    const first = new Deferred<ReturnType<typeof stream>>();
    let calls = 0;
    const { deps, schedulerTargets } = makeDeps([]);
    deps.createStream = () => {
      calls++;
      if (calls === 1) return first.promise;
      return Promise.resolve(stream(20 + calls));
    };
    const runtime = new MultiFoveaRuntime({ activeRequestCount: 0 }, deps);
    runtime.setFrameSize({ width: 100, height: 100 });
    runtime.setTargets([target(0)]);
    await flush();
    runtime.setTargets([target(0), target(1)]);
    const stale = stream(7);
    first.resolve(stale);
    for (let i = 0; i < 5; i++) await flush();

    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(schedulerTargets.at(-1)).toEqual([{ stream: 22 }, { stream: 23 }]);
  });
});
