// `disparity-scope/tracker.ts`'s `AsyncKcfTracker` — PB3 A-4 (docs/refactor/
// orchestrator.md §6). Replaces a synchronous per-frame `tracker.update()`
// (one of the two PB3 root causes) with the T6 `updateAsync` pattern:
// busy-drop overlapping ticks, apply results on completion with a staleness
// guard so a completion for a released/re-initialized tracker never lands.

import { describe, expect, it } from "vitest";
import type { Mat } from "core/Vision";
import type { Rect } from "core/Geometry";
import { AsyncKcfTracker, type TrackerLike } from "@modules/disparity-scope/tracker";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const FRAME = {} as Mat<Uint8Array>;

function makeDeps(createTracker: () => TrackerLike) {
  return {
    createTracker,
    clampRect: (r: Rect) => r,
    searchWindow: (box: Rect) => box,
    cropPatch: (_view: Mat<Uint8Array>, _win: Rect) => FRAME,
    lostTolerance: 3,
  };
}

describe("AsyncKcfTracker", () => {
  it("init() then a resolved update() reports the tracked bbox", async () => {
    const bbox: Rect = { x: 10, y: 10, width: 20, height: 20 };
    const tracker: TrackerLike = {
      init: () => {},
      updateAsync: async () => bbox,
      release: () => {},
    };
    const kcf = new AsyncKcfTracker(makeDeps(() => tracker));
    kcf.init(FRAME, { x: 0, y: 0, width: 20, height: 20 });
    expect(kcf.active).toBe(true);

    const result = await kcf.update(FRAME);
    expect(result.status).toBe("tracking");
    if (result.status === "tracking") {
      expect(result.bbox).toEqual(bbox);
      expect(result.center).toEqual({ x: 20, y: 20 });
    }
  });

  it("busy-drops a tick that arrives while a previous update is in flight", async () => {
    const gate = deferred<Rect | null>();
    let calls = 0;
    const tracker: TrackerLike = {
      init: () => {},
      updateAsync: async () => {
        calls++;
        return gate.promise;
      },
      release: () => {},
    };
    const kcf = new AsyncKcfTracker(makeDeps(() => tracker));
    kcf.init(FRAME, { x: 0, y: 0, width: 20, height: 20 });

    const first = kcf.update(FRAME); // now in flight, awaiting the native call
    expect(kcf.updating).toBe(true);
    const second = kcf.update(FRAME); // reentrant — must not call updateAsync again

    gate.resolve({ x: 5, y: 5, width: 20, height: 20 });
    const [r1, r2] = await Promise.all([first, second]);
    expect(calls).toBe(1); // only the first tick actually reached the native call
    expect(r1.status).toBe("tracking");
    expect(r2.status).toBe("dropped");
  });

  it("discards a stale completion after release() (e.g. session idle/re-target)", async () => {
    const gate = deferred<Rect | null>();
    const tracker: TrackerLike = {
      init: () => {},
      updateAsync: async () => gate.promise,
      release: () => {},
    };
    const kcf = new AsyncKcfTracker(makeDeps(() => tracker));
    kcf.init(FRAME, { x: 0, y: 0, width: 20, height: 20 });

    const pending = kcf.update(FRAME); // in flight
    kcf.release(); // e.g. session idle or a user re-target mid-flight
    expect(kcf.active).toBe(false);

    gate.resolve({ x: 99, y: 99, width: 20, height: 20 }); // completion arrives after release
    const result = await pending;
    expect(result.status).toBe("dropped"); // never applied — bbox/search untouched
    expect(kcf.bbox).toBeNull();
  });

  it("discards a stale completion after re-init with a new tracker", async () => {
    const gateA = deferred<Rect | null>();
    const trackerA: TrackerLike = {
      init: () => {},
      updateAsync: async () => gateA.promise,
      release: () => {},
    };
    const trackerB: TrackerLike = {
      init: () => {},
      updateAsync: async () => ({ x: 1, y: 1, width: 10, height: 10 }),
      release: () => {},
    };
    let which: "A" | "B" = "A";
    const kcf = new AsyncKcfTracker(makeDeps(() => (which === "A" ? trackerA : trackerB)));

    kcf.init(FRAME, { x: 0, y: 0, width: 20, height: 20 }); // tracker A
    const staleUpdate = kcf.update(FRAME); // in flight against A

    which = "B";
    kcf.init(FRAME, { x: 50, y: 50, width: 10, height: 10 }); // re-init onto B mid-flight

    gateA.resolve({ x: 42, y: 42, width: 20, height: 20 }); // A's stale completion arrives
    const staleResult = await staleUpdate;
    expect(staleResult.status).toBe("dropped");
    // B's own bbox (from init, not touched by A's stale completion) survives.
    expect(kcf.bbox).toEqual({ x: 50, y: 50, width: 10, height: 10 });
  });

  it("release() after lost-tolerance reports \"lost\" and clears the tracker", async () => {
    const tracker: TrackerLike = {
      init: () => {},
      updateAsync: async () => null, // every tick misses
      release: () => {},
    };
    const kcf = new AsyncKcfTracker(makeDeps(() => tracker));
    kcf.init(FRAME, { x: 0, y: 0, width: 20, height: 20 });

    expect((await kcf.update(FRAME)).status).toBe("dropped"); // miss 1
    expect((await kcf.update(FRAME)).status).toBe("dropped"); // miss 2
    const third = await kcf.update(FRAME); // miss 3 === lostTolerance
    expect(third.status).toBe("lost");
    expect(kcf.active).toBe(false);
  });
});
