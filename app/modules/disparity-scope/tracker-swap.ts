// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Runtime-selectable OBJECT TRACKER type for disparity-scope (the drop-in
// replacement nodes, user request 2026-07-11). Two chained tracker factories
// with an IDENTICAL handle surface — `createChainedHybridTracker` (NCC match +
// re-detect; the default since bc20269) and `createChainedTracker` (GRAY-pinned
// KCF) — are hot-swappable on the SAME source pipe + graph node id: same
// `TrackResult` schema, same `arm/override/probe/release` API, same meter shape.
// That equivalence is what lets the session release one and spin the other
// up mid-session without a graph churn or a session restart.
//
// This module is PURE (no core / native imports): it holds the tracker-type
// enum + its default and the release→create→resume→re-arm SEQUENCING as an
// injected-op reducer, so vitest exercises the decision path without loading
// the native addon (same pattern as tracker-feed.ts / vergence.ts).

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

/**
 * Swap the running tracker to `requested`, preserving steering:
 *   1. release the old tracker (its consume loop exits, native link drops);
 *   2. create the requested type on the same source + node id;
 *   3. resume consumption with the shared feed;
 *   4. re-arm at the current target IFF `wasArmed`.
 *
 * DEGRADE (requirement 4): if step 2 throws (no brick), fall back to
 * `fallback` — the type that WAS running — so a working tracker keeps running
 * and the caller can pin the select to the real type (`ok:false`,
 * `type:fallback`). If the fallback create ALSO throws, returns a null tracker.
 *
 * Pure sequencing: every side effect goes through `ops`, so a test asserts the
 * order (release-before-create, consume-before-rearm) and the arm-only-if-armed
 * gate with plain spy fns.
 */
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
