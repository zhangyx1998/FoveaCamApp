// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disparity-scope's wide-angle auto-follow tracker (PB3 A-4, docs/refactor/
// orchestrator.md §6): extracted out of `session.ts` so the busy-drop +
// staleness-guard logic can be unit-tested without spinning up the full
// session harness — same shape as `multi-fovea/runtime.ts`'s per-slot
// tracker handling (T6's `KCF.updateAsync`), collapsed to a single tracker.
//
// Previously `session.ts` ran a *synchronous* `tracker.update(frame)` inline
// inside `onCenterView` — one of the two PB3 root causes (the registry's
// camera loop can't pull the next frame until every `onView` sink returns,
// so a slow synchronous KCF update throttled the whole serial). `update()`
// here instead awaits the AsyncTask-backed `updateAsync` (native thread
// pool), and:
//  - busy-drops: a tick that arrives while a previous update is still
//    resolving is skipped outright (checked by the caller via `updating`
//    before calling `update()` again — `update()` itself also no-ops if
//    called reentrantly, so either caller shape is safe).
//  - guards staleness: `release()` (called on explicit release, re-init, and
//    lost-tolerance) bumps `generation`; a completion whose captured
//    generation no longer matches is discarded without touching `search`/
//    `lostCount` — the V5/V10/V13 stale-async-completion class.
//
// Copy-before-await: `cropPatch` (session-supplied: `slice` + `cvtColor`) is
// called synchronously inside `update()`, before the `await` — the resulting
// patch is an independent Mat, safe past the await even though `view` itself
// is a reused registry tap buffer (see docs/refactor/orchestrator.md §3).

import type { Point2d, Rect } from "core/Geometry";
import type { Mat } from "core/Vision";
import { RECT } from "@lib/util/geometry";

export interface TrackerLike {
  init(frame: Mat<Uint8Array>, roi: Rect): void;
  updateAsync(frame: Mat<Uint8Array>): Promise<Rect | null>;
  release(): void;
}

export interface AsyncKcfTrackerDeps {
  createTracker(): TrackerLike;
  /** Clamp a rect to the current frame bounds. */
  clampRect(r: Rect): Rect;
  /** Expand a box into a search window (padded, clamped), `scale` widening it
   *  further after consecutive misses. */
  searchWindow(box: Rect, scale?: number): Rect;
  /** Synchronous crop + convert (`slice` + `cvtColor`) into an independent
   *  Mat — see the copy-before-await note above. */
  cropPatch(view: Mat<Uint8Array>, win: Rect): Mat<Uint8Array>;
  lostTolerance: number;
}

export type TrackerUpdateResult =
  | { status: "tracking"; bbox: Rect; center: Point2d }
  | { status: "lost" }
  | { status: "dropped" }; // busy (reentrant) or completion arrived stale

export class AsyncKcfTracker {
  private tracker: TrackerLike | null = null;
  private search: Rect | null = null;
  private lostCount = 0;
  private busy = false;
  private generation = 0;

  constructor(private readonly deps: AsyncKcfTrackerDeps) {}

  get active(): boolean {
    return this.tracker !== null;
  }

  get updating(): boolean {
    return this.busy;
  }

  get bbox(): Rect | null {
    return this.search;
  }

  /** (Re)init on `roi`, releasing any previous tracker (and invalidating any
   *  of its in-flight `update()` completions via `release()`'s generation
   *  bump). */
  init(view: Mat<Uint8Array>, roi: Rect): void {
    this.release();
    const win = this.deps.searchWindow(roi);
    const patch = this.deps.cropPatch(view, win);
    const roiInPatch: Rect = {
      x: roi.x - win.x,
      y: roi.y - win.y,
      width: roi.width,
      height: roi.height,
    };
    const t = this.deps.createTracker();
    t.init(patch, roiInPatch);
    this.tracker = t;
    this.search = roi;
    this.lostCount = 0;
  }

  release(): void {
    this.generation++; // any in-flight update() completion becomes stale
    this.tracker?.release();
    this.tracker = null;
    this.search = null;
    this.lostCount = 0;
  }

  /** Busy-drop + staleness-guarded update. Never called reentrantly with
   *  itself in practice (callers check `updating` first), but also safe if
   *  they don't: a second concurrent call just resolves to `"dropped"`. */
  async update(view: Mat<Uint8Array>): Promise<TrackerUpdateResult> {
    if (!this.tracker || !this.search || this.busy) return { status: "dropped" };
    this.busy = true;
    const generation = this.generation;
    const tracker = this.tracker;
    try {
      const win = this.deps.searchWindow(this.search, 1 + this.lostCount);
      const patch = this.deps.cropPatch(view, win); // copied synchronously — safe past the await
      const result = await tracker.updateAsync(patch);
      // Stale: released, re-initialized, or torn down while this was in flight.
      if (generation !== this.generation) return { status: "dropped" };
      if (result) {
        this.lostCount = 0;
        const full = this.deps.clampRect({
          x: result.x + win.x,
          y: result.y + win.y,
          width: result.width,
          height: result.height,
        });
        this.search = full;
        return { status: "tracking", bbox: full, center: RECT.getCenter(full) };
      }
      if (++this.lostCount >= this.deps.lostTolerance) {
        this.release();
        return { status: "lost" };
      }
      return { status: "dropped" };
    } finally {
      this.busy = false;
    }
  }
}
