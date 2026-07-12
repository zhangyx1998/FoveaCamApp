// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disparity-scope's JS-side consumer of the chained tracker thread — a pure
// per-result REDUCER (types-only, unit-testable with synthetic `TrackResult`s).
// Routing semantics (overridden always processed, armed-gated normals, lost
// after N consecutive misses): docs/spec/disparity-scope.md §tracker.

import type { TrackResult } from "core/Tracker";
import type { Point2d, Rect } from "core/Geometry";

export interface DisparityTrackerHandlers {
  /** JS-side gate for NORMAL (non-overridden) results: while false, they are
   *  ignored (auto-follow off / lost-released). Overridden results bypass it. */
  armed(): boolean;
  /** An OVERRIDDEN result — `center` is the drag point the override pinned. */
  onDrag(center: Point2d): void;
  /** A found result while armed — `center`/`bbox` in the tracked (undistorted
   *  C) frame's pixels. */
  onTrack(center: Point2d, bbox: Rect): void;
  /** `lostTolerance` consecutive misses while armed (fires once per streak). */
  onLost(): void;
}

/** Per-result reducer: feed every `TrackResult` off the tracker thread. */
export function createDisparityTrackerFeed(
  h: DisparityTrackerHandlers,
  lostTolerance = 10,
): (r: TrackResult) => void {
  let lostCount = 0;
  return (r: TrackResult): void => {
    if (r.overridden) {
      lostCount = 0;
      if (r.center) h.onDrag(r.center);
      return;
    }
    if (!h.armed()) {
      lostCount = 0; // released mid-streak: a future re-arm starts fresh
      return;
    }
    if (r.found && r.center && r.bbox) {
      lostCount = 0;
      h.onTrack(r.center, r.bbox);
      return;
    }
    if (++lostCount >= lostTolerance) {
      lostCount = 0;
      h.onLost();
    }
  };
}

/** Drive the tracker's async iteration until the iterator closes (on
 *  `tracker.release()` at teardown — swallowed as a normal exit). */
export async function consumeTracker(
  results: AsyncIterable<TrackResult>,
  onResult: (r: TrackResult) => void,
): Promise<void> {
  try {
    for await (const r of results) onResult(r);
  } catch {
    // Iterator closed (release/teardown) — normal exit.
  }
}

/** Deadline for the tracker-stall WATCHDOG (mirror-flicker addendum R3):
 *  ~5 tracker periods at the ~30 fps floor. The count-based lost tolerance
 *  above only covers DELIVERED misses — a stalled source (wedged tracker
 *  thread, stalled camera pipe, dropped kcf→imm link mid-swap) delivers
 *  NOTHING, so `trackerActive` froze true and rebases kept feed-forward on
 *  while the predictor coasted. Param'd for the rig. */
export const TRACKER_STALL_DEADLINE_MS = 150;

/** True when no tracker result has arrived within the deadline — the session
 *  treats it exactly like `onLost` (the match-staleness precedent's shape:
 *  a pure predicate, wiring in the session). Corrupt clock ⇒ stalled. */
export function trackerResultStale(
  ageMs: number,
  deadlineMs = TRACKER_STALL_DEADLINE_MS,
): boolean {
  if (!Number.isFinite(ageMs) || ageMs < 0) return true;
  return ageMs > deadlineMs;
}
