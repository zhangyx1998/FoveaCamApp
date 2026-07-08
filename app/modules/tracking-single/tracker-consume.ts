// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 1d: the JS-side consumer of B's native KCF tracker thread. `Tracker`
// (from `core/Tracker.createTracker`) is an `AsyncIterable<TrackResult>` whose
// results arrive off the JS loop; this drives that iteration and fans each
// result to the session's found/lost handlers, gated by `armed()` (the JS-side
// "is a target engaged" flag — there is no native disarm). Extracted from the
// session closure so the wiring is unit-testable with a fake Tracker stub
// (types-only imports → no native load).

import type { TrackResult } from "core/Tracker";
import type { Rect } from "core/Geometry";

export interface TrackConsumerHandlers {
  /** JS-side gate: while false (released, not yet armed), results are ignored. */
  armed(): boolean;
  /** A found result — `bbox` is in RAW center-sensor pixels (the native thread
   *  runs full-frame KCF on the raw stream). */
  onFound(bbox: Rect): void;
  /** A lost result (KCF returned no box this frame). */
  onLost(): void;
}

/** Consume the tracker's result stream until the iterator closes (on
 *  `tk.release()` at teardown — swallowed as a normal exit). */
export async function consumeTrackerResults(
  results: AsyncIterable<TrackResult>,
  h: TrackConsumerHandlers,
): Promise<void> {
  try {
    for await (const r of results) {
      if (!h.armed()) continue; // released while running — ignore until re-armed
      if (r.found && r.bbox) h.onFound(r.bbox);
      else h.onLost();
    }
  } catch {
    // Iterator closed (release/teardown) — normal exit.
  }
}
