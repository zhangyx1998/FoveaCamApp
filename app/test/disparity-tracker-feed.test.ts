// Disparity-scope's chained-tracker result routing: the KCF runs on its own
// native thread; the session feeds every
// `TrackResult` through the pure reducer in `tracker-feed.ts`, which routes
//   - OVERRIDDEN results (a pointer drag) → onDrag, ALWAYS (bypass the armed
//     gate — the drag is the user), so the override flag reaches the kernel
//     (→ projection.overridden → PID) even with auto-follow off;
//   - found results → onTrack, gated by armed();
//   - misses → counted; `lostTolerance` consecutive misses fire onLost ONCE.
// Pure (types-only core imports) — no native addon loads here.

import { describe, expect, it, vi } from "vitest";
import {
  createDisparityTrackerFeed,
  consumeTracker,
  type DisparityTrackerHandlers,
  TRACKER_STALL_DEADLINE_MS,
  trackerResultStale,
} from "@modules/disparity-scope/tracker-feed";
import type { TrackResult } from "core/Tracker";
import type { Point2d, Rect } from "core/Geometry";

let seq = 0;
function result(over: {
  found?: boolean;
  overridden?: boolean;
  center?: Point2d | null;
  bbox?: Rect | null;
}): TrackResult {
  const center = over.center === undefined ? { x: 10, y: 20 } : over.center;
  const bbox =
    over.bbox === undefined
      ? center
        ? { x: center.x - 5, y: center.y - 5, width: 10, height: 10 }
        : null
      : over.bbox;
  return {
    found: over.found ?? true,
    overridden: over.overridden ?? false,
    center,
    bbox,
    seq: seq++,
    deviceTimestamp: BigInt(seq),
  };
}

function handlers(armed = true) {
  const h = {
    armed: vi.fn(() => armed),
    onDrag: vi.fn<[Point2d], void>(),
    onTrack: vi.fn<[Point2d, Rect], void>(),
    onLost: vi.fn<[], void>(),
    setArmed(v: boolean) {
      armed = v;
    },
  };
  return h satisfies DisparityTrackerHandlers & { setArmed(v: boolean): void };
}

describe("createDisparityTrackerFeed (result routing)", () => {
  it("routes found results to onTrack while armed", () => {
    const h = handlers(true);
    const feed = createDisparityTrackerFeed(h);
    feed(result({ center: { x: 3, y: 4 } }));
    expect(h.onTrack).toHaveBeenCalledTimes(1);
    expect(h.onTrack).toHaveBeenCalledWith(
      { x: 3, y: 4 },
      { x: -2, y: -1, width: 10, height: 10 },
    );
    expect(h.onDrag).not.toHaveBeenCalled();
    expect(h.onLost).not.toHaveBeenCalled();
  });

  it("ignores normal results while NOT armed (JS gate — native has no disarm)", () => {
    const h = handlers(false);
    const feed = createDisparityTrackerFeed(h);
    feed(result({}));
    feed(result({ found: false, center: null, bbox: null }));
    expect(h.onTrack).not.toHaveBeenCalled();
    expect(h.onLost).not.toHaveBeenCalled();
  });

  it("OVERRIDDEN results bypass the armed gate — the drag always drives onDrag", () => {
    const h = handlers(false); // auto-follow OFF: drag must still work
    const feed = createDisparityTrackerFeed(h);
    feed(result({ overridden: true, center: { x: 7, y: 8 }, bbox: null }));
    expect(h.onDrag).toHaveBeenCalledTimes(1);
    expect(h.onDrag).toHaveBeenCalledWith({ x: 7, y: 8 });
    expect(h.onTrack).not.toHaveBeenCalled();
  });

  it("fires onLost ONCE after lostTolerance consecutive misses, then restarts the count", () => {
    const h = handlers(true);
    const feed = createDisparityTrackerFeed(h, 3);
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({ found: false, center: null, bbox: null }));
    expect(h.onLost).not.toHaveBeenCalled();
    feed(result({ found: false, center: null, bbox: null })); // 3rd miss
    expect(h.onLost).toHaveBeenCalledTimes(1);
    // Streak restarts (a still-armed caller isn't spammed every miss).
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({ found: false, center: null, bbox: null }));
    expect(h.onLost).toHaveBeenCalledTimes(1);
    feed(result({ found: false, center: null, bbox: null }));
    expect(h.onLost).toHaveBeenCalledTimes(2);
  });

  it("a found result resets the miss streak", () => {
    const h = handlers(true);
    const feed = createDisparityTrackerFeed(h, 3);
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({})); // reacquired
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({ found: false, center: null, bbox: null }));
    expect(h.onLost).not.toHaveBeenCalled(); // 2+2 misses never reach 3 in a row
    feed(result({ found: false, center: null, bbox: null }));
    expect(h.onLost).toHaveBeenCalledTimes(1);
  });

  it("an overridden result resets the miss streak (drag interrupts a losing streak)", () => {
    const h = handlers(true);
    const feed = createDisparityTrackerFeed(h, 3);
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({ overridden: true, center: { x: 1, y: 1 }, bbox: null }));
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({ found: false, center: null, bbox: null }));
    expect(h.onLost).not.toHaveBeenCalled();
  });

  it("a disarm mid-streak resets the count (a re-arm starts fresh)", () => {
    const h = handlers(true);
    const feed = createDisparityTrackerFeed(h, 3);
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({ found: false, center: null, bbox: null }));
    h.setArmed(false);
    feed(result({ found: false, center: null, bbox: null })); // ignored + resets
    h.setArmed(true);
    feed(result({ found: false, center: null, bbox: null }));
    feed(result({ found: false, center: null, bbox: null }));
    expect(h.onLost).not.toHaveBeenCalled();
    feed(result({ found: false, center: null, bbox: null }));
    expect(h.onLost).toHaveBeenCalledTimes(1);
  });

  it("drag → release → re-armed tracking: the full gesture in result order", () => {
    // Mirrors the drag flow: overridden results while dragging (flag
    // rides downstream), then normal found results after releaseOverride
    // re-arms at the drag end.
    const h = handlers(true);
    const feed = createDisparityTrackerFeed(h);
    feed(result({})); // auto-follow before the drag
    feed(result({ overridden: true, center: { x: 50, y: 50 } }));
    feed(result({ overridden: true, center: { x: 60, y: 55 } }));
    feed(result({ center: { x: 60, y: 55 } })); // re-armed at drag end
    expect(h.onTrack).toHaveBeenCalledTimes(2);
    expect(h.onDrag).toHaveBeenNthCalledWith(1, { x: 50, y: 50 });
    expect(h.onDrag).toHaveBeenNthCalledWith(2, { x: 60, y: 55 });
    expect(h.onTrack).toHaveBeenLastCalledWith(
      { x: 60, y: 55 },
      expect.objectContaining({ width: 10, height: 10 }),
    );
  });
});

describe("consumeTracker (iteration driver)", () => {
  it("feeds every yielded result and exits cleanly when the iterator closes", async () => {
    const seen: number[] = [];
    async function* results(): AsyncGenerator<TrackResult> {
      yield result({ center: { x: 1, y: 1 } });
      yield result({ center: { x: 2, y: 2 } });
    }
    await consumeTracker(results(), (r) => seen.push(r.center!.x));
    expect(seen).toEqual([1, 2]);
  });

  it("swallows an iterator error (release/teardown) as a normal exit", async () => {
    async function* results(): AsyncGenerator<TrackResult> {
      yield result({});
      throw new Error("released");
    }
    const onResult = vi.fn();
    await expect(consumeTracker(results(), onResult)).resolves.toBeUndefined();
    expect(onResult).toHaveBeenCalledTimes(1);
  });

});

// ---- stall watchdog predicate --------------------
// The count-based lostTolerance above only covers DELIVERED misses; a stalled
// source delivers nothing — the session's watchdog uses this predicate on the
// delivery-heartbeat age (the match-staleness precedent's pure-helper shape).
describe("trackerResultStale", () => {
  it("fresh within the deadline", () => {
    expect(trackerResultStale(0)).toBe(false);
    expect(trackerResultStale(TRACKER_STALL_DEADLINE_MS)).toBe(false); // boundary
  });
  it("stale past the deadline (~5 tracker periods)", () => {
    expect(trackerResultStale(TRACKER_STALL_DEADLINE_MS + 1)).toBe(true);
  });
  it("custom deadline is honored (param'd for the rig)", () => {
    expect(trackerResultStale(90, 80)).toBe(true);
    expect(trackerResultStale(70, 80)).toBe(false);
  });
  it("a corrupt clock reads as stalled (hold, never steer)", () => {
    expect(trackerResultStale(-1)).toBe(true);
    expect(trackerResultStale(NaN)).toBe(true);
  });
});
