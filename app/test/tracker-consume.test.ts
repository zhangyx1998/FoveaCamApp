// WS1 1d KCF cut-over (A-24 Stage 2): the JS consumer of B's native tracker
// thread. Drives `consumeTrackerResults` with a fake `Tracker` async-iterable
// (arm → results stream → found/lost publish → release closes the iterator) —
// the wiring the tracking session folds into its A-P1 scope. Types-only imports,
// no native.

import { describe, expect, it, vi } from "vitest";
import { consumeTrackerResults } from "@modules/tracking-single/tracker-consume";
import type { TrackResult } from "core/Tracker";
import type { Rect } from "core/Geometry";

const box = (x: number): Rect => ({ x, y: x, width: 10, height: 10 });
const found = (x: number): TrackResult =>
  ({ found: true, bbox: box(x), seq: x, deviceTimestamp: 0n }) as TrackResult;
const lost = (): TrackResult =>
  ({ found: false, bbox: null, seq: 0, deviceTimestamp: 0n }) as TrackResult;

/** A controllable fake native tracker: push results, then `release()` to close
 *  the async iterator (mirrors `tk.release()` at teardown). */
function fakeTracker() {
  const queue: TrackResult[] = [];
  let resolve: (() => void) | null = null;
  let closed = false;
  const iterator: AsyncIterableIterator<TrackResult> = {
    async next() {
      for (;;) {
        if (queue.length) return { value: queue.shift()!, done: false };
        if (closed) return { value: undefined as never, done: true };
        await new Promise<void>((r) => (resolve = r));
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    results: iterator,
    push(r: TrackResult) {
      queue.push(r);
      resolve?.();
      resolve = null;
    },
    release() {
      closed = true;
      resolve?.();
      resolve = null;
    },
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("consumeTrackerResults (WS1 1d)", () => {
  it("fans found/lost results to the handlers, ends on release()", async () => {
    const tk = fakeTracker();
    const onFound = vi.fn();
    const onLost = vi.fn();
    const done = consumeTrackerResults(tk.results, { armed: () => true, onFound, onLost });

    tk.push(found(5));
    await tick();
    expect(onFound).toHaveBeenCalledWith(box(5));

    tk.push(lost());
    await tick();
    expect(onLost).toHaveBeenCalledTimes(1);

    tk.push(found(7));
    await tick();
    expect(onFound).toHaveBeenLastCalledWith(box(7));

    tk.release(); // teardown → iterator closes → the loop exits
    await expect(done).resolves.toBeUndefined();
  });

  it("ignores results while not armed (disengaged), resumes when armed", async () => {
    const tk = fakeTracker();
    const onFound = vi.fn();
    const onLost = vi.fn();
    let armed = false;
    const done = consumeTrackerResults(tk.results, { armed: () => armed, onFound, onLost });

    tk.push(found(1));
    await tick();
    expect(onFound).not.toHaveBeenCalled(); // gated off while disengaged

    armed = true;
    tk.push(found(2));
    await tick();
    expect(onFound).toHaveBeenCalledWith(box(2));

    tk.release();
    await done;
  });
});
