// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disparity-scope's JS-side consumer of the CHAINED KCF tracker thread
// (controller-node-and-fifo-edges §3.5). The tracker runs on its OWN native
// thread, chained on the C undistort brick's OwnedFrame tap (latest-wins), so
// tracking latency no longer rides the disparity-matching budget; the session
// forwards each scalar result to the disparity kernel as the target center
// (params-style push at result rate — thin-coordinator compliant).
//
// Pure per-result REDUCER (types-only imports → no native load), extracted
// from the session closure so the routing is unit-testable with synthetic
// `TrackResult`s — the same pattern as tracking-single's `tracker-consume`.
//
// Routing semantics (mirrors the RULED drag flow):
//  - OVERRIDDEN results (a pointer drag pinned the tracker) are ALWAYS
//    processed — the drag is the user; the `armed()` gate does not apply.
//    `onDrag(center)` fires with the drag point every frame, and the override
//    flag rides downstream (session → kernel target → projection → PID).
//  - Normal results are gated by `armed()` (the JS-side "auto-follow engaged"
//    flag — native has NO disarm, same as tracking-single: released targets
//    keep emitting results, the gate ignores them until re-armed).
//  - Found → `onTrack(center, bbox)`; miss → counted, and after
//    `lostTolerance` CONSECUTIVE misses `onLost()` fires ONCE (the counter
//    resets so a still-armed caller isn't spammed). Lost POLICY (disarm,
//    target fallback) is the caller's, matching the old in-kernel tolerance.

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
