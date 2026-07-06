import { describe, expect, it, vi } from "vitest";
import type { Mat } from "core/Vision";
import type { Rect } from "core/Geometry";
import { MultiFoveaRuntime, type TrackerLike } from "@modules/multi-fovea/runtime";
import { defaultMultiFoveaTarget } from "@modules/multi-fovea/contract";

function frame(): Mat<Uint8Array> {
  return Object.assign(new Uint8Array(100 * 100 * 4), {
    shape: [100, 100] as [number, number],
    channels: 4,
  }) as unknown as Mat<Uint8Array>;
}

class FakeTracker implements TrackerLike {
  init = vi.fn();
  updateAsync = vi.fn<[], Promise<Rect | null>>(async () => ({
    x: 10,
    y: 20,
    width: 8,
    height: 6,
  }));
  release = vi.fn();
}

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

describe("MultiFoveaRuntime", () => {
  it("drives enabled trackers sequentially and updates one stream per target", async () => {
    const trackers: FakeTracker[] = [];
    const streams = [
      { id: 10, update: vi.fn(), close: vi.fn(async () => {}) },
      { id: 11, update: vi.fn(), close: vi.fn(async () => {}) },
    ];
    const schedulerTargets: Array<Array<{ stream: number }>> = [];
    const runtime = new MultiFoveaRuntime(
      { activeRequestCount: 0 },
      {
        createTracker() {
          const tracker = new FakeTracker();
          trackers.push(tracker);
          return tracker;
        },
        async createStream(index) {
          return streams[index] ?? null;
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
      },
    );

    const targets = [defaultMultiFoveaTarget(0), defaultMultiFoveaTarget(1)];
    targets[1] = { ...targets[1], enabled: true };
    runtime.setTargets(targets);
    await flush();

    await runtime.onCenterFrame(frame());
    expect(trackers).toHaveLength(2);
    expect(trackers[0].init).toHaveBeenCalledTimes(1);
    expect(trackers[1].init).toHaveBeenCalledTimes(1);
    expect(streams[0].update).toHaveBeenCalledTimes(1);
    expect(streams[1].update).toHaveBeenCalledTimes(1);
    expect(schedulerTargets.at(-1)).toEqual([{ stream: 10 }, { stream: 11 }]);

    await runtime.onCenterFrame(frame());
    expect(trackers[0].updateAsync).toHaveBeenCalledTimes(1);
    expect(trackers[1].updateAsync).toHaveBeenCalledTimes(1);
  });

  it("ignores async tracker completions after dispose", async () => {
    let resolveUpdate!: (rect: Rect | null) => void;
    class SlowTracker implements TrackerLike {
      init = vi.fn();
      updateAsync = vi.fn(
        () =>
          new Promise<Rect | null>((resolve) => {
            resolveUpdate = resolve;
          }),
      );
      release = vi.fn();
    }
    const tracker = new SlowTracker();
    const stream = { id: 3, update: vi.fn(), close: vi.fn(async () => {}) };
    const publish = vi.fn();
    const runtime = new MultiFoveaRuntime(
      { activeRequestCount: 0 },
      {
        createTracker: () => tracker,
        async createStream() {
          return stream;
        },
        targetPose(_index, center) {
          return {
            angle: center,
            volt: { L: { x: center.x, y: center.y }, R: { x: center.x, y: center.y } },
          };
        },
        updateScheduler: vi.fn(),
        publish,
      },
    );

    runtime.setTargets([defaultMultiFoveaTarget(0)]);
    await flush();
    await runtime.onCenterFrame(frame());
    const pending = runtime.onCenterFrame(frame());
    runtime.dispose();
    resolveUpdate({ x: 30, y: 40, width: 6, height: 6 });
    await pending;

    expect(tracker.release).toHaveBeenCalled();
    expect(stream.update).toHaveBeenCalledTimes(1);
  });

  it("closes a stream handle that resolves after dispose", async () => {
    const pending = new Deferred<{ id: number; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>();
    const updateScheduler = vi.fn();
    const runtime = new MultiFoveaRuntime(
      { activeRequestCount: 0 },
      {
        createTracker: () => new FakeTracker(),
        createStream: () => pending.promise,
        targetPose(_index, center) {
          return {
            angle: center,
            volt: { L: { x: center.x, y: center.y }, R: { x: center.x, y: center.y } },
          };
        },
        updateScheduler,
        publish: vi.fn(),
      },
    );

    runtime.setTargets([defaultMultiFoveaTarget(0)]);
    await flush();
    runtime.dispose();
    const stale = { id: 8, update: vi.fn(), close: vi.fn(async () => {}) };
    pending.resolve(stale);
    await flush();

    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(updateScheduler).toHaveBeenLastCalledWith([]);
  });

  it("reruns stream sync when targets change during an in-flight create", async () => {
    const first = new Deferred<{ id: number; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>();
    const created: Array<{ id: number; update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const schedulerTargets: Array<Array<{ stream: number }>> = [];
    let calls = 0;
    const runtime = new MultiFoveaRuntime(
      { activeRequestCount: 0 },
      {
        createTracker: () => new FakeTracker(),
        createStream() {
          calls++;
          if (calls === 1) return first.promise;
          const stream = { id: 20 + calls, update: vi.fn(), close: vi.fn(async () => {}) };
          created.push(stream);
          return Promise.resolve(stream);
        },
        targetPose(_index, center) {
          return {
            angle: center,
            volt: { L: { x: center.x, y: center.y }, R: { x: center.x, y: center.y } },
          };
        },
        updateScheduler(targets) {
          schedulerTargets.push(targets);
        },
        publish: vi.fn(),
      },
    );

    const targets = [defaultMultiFoveaTarget(0), defaultMultiFoveaTarget(1)];
    runtime.setTargets([targets[0]]);
    await flush();
    targets[1] = { ...targets[1], enabled: true };
    runtime.setTargets(targets);
    const stale = { id: 7, update: vi.fn(), close: vi.fn(async () => {}) };
    first.resolve(stale);
    for (let i = 0; i < 5; i++) await flush();

    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(schedulerTargets.at(-1)).toEqual([{ stream: 22 }, { stream: 23 }]);
  });
});
