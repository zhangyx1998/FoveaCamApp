// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Runtime-selectable OBJECT TRACKER type for disparity-scope — two chained
// factories with an IDENTICAL handle surface, hot-swappable on the same source
// pipe + node id. PURE: the tracker-type enum + the release→create→resume→re-arm
// sequencing as an injected-op reducer (unit-testable without the native addon).
// Hot-swap semantics + degrade path: docs/spec/disparity-scope.md §tracker.

/** Which object-tracker engine the session runs. Both factories are drop-in
 *  (identical `KcfTracker` surface). Session-local, not persisted. */
export type TrackerType = "hybrid" | "kcf";

/** The default tracker — the current behavior (hybrid NCC + re-detect, the
 *  session default since bc20269). Referenced by the contract's state default
 *  so the two never drift. */
export const DEFAULT_TRACKER_TYPE: TrackerType = "hybrid";

/** The side-effecting operations the swap sequences, injected so the ordering
 *  is unit-testable with plain spies (no native tracker needed). */
export interface SwapTrackerOps<T> {
  /** Release the currently-running tracker — closes its result iterator (the
   *  `consumeTracker` loop exits) and drops any native measurement link. */
  release(tracker: T): void;
  /** Create a fresh tracker of `type` on the SAME source pipe + graph node id.
   *  THROWS when the brick is gone (degradation path). */
  create(type: TrackerType): T;
  /** Resume consumption of the new tracker's results with the shared feed (and
   *  re-establish any downstream native links, e.g. kcf → imm). */
  consume(tracker: T): void;
  /** Re-arm the new tracker at the current target — called ONLY when the
   *  auto-follow gate was armed before the swap. */
  rearm(tracker: T): void;
}

export interface SwapTrackerResult<T> {
  /** The tracker now running, or null when BOTH the requested and the fallback
   *  factory threw (degrade to pointer-only targeting). */
  tracker: T | null;
  /** The type actually running — equals `requested` on success, `fallback` on
   *  a degraded swap. The caller writes this back to state so the UI never
   *  advertises a type that isn't running. */
  type: TrackerType;
  /** True when the REQUESTED type is what's running. */
  ok: boolean;
}

/** Swap the running tracker to `requested`, preserving steering (spec §tracker):
 *  release → create on the same source/node → resume consume → re-arm iff
 *  `wasArmed`. DEGRADE: a create throw falls back to `fallback` (the running
 *  type; `ok:false`), a fallback throw too → null tracker. Pure sequencing via
 *  `ops` so a test asserts the order with plain spies. */
export function swapTracker<T>(
  old: T | null,
  requested: TrackerType,
  fallback: TrackerType,
  wasArmed: boolean,
  ops: SwapTrackerOps<T>,
): SwapTrackerResult<T> {
  if (old !== null) ops.release(old);
  let tracker: T | null = null;
  let type = requested;
  let ok = true;
  try {
    tracker = ops.create(requested);
  } catch {
    ok = false;
    // Fall back to the previously-running type so a tracker keeps running.
    if (fallback !== requested) {
      try {
        tracker = ops.create(fallback);
        type = fallback;
      } catch {
        tracker = null;
      }
    } else {
      tracker = null;
    }
  }
  if (tracker !== null) {
    ops.consume(tracker);
    if (wasArmed) ops.rearm(tracker);
  }
  return { tracker, type, ok };
}
