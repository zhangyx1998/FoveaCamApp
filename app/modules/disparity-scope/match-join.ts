// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE staleness bound for the disparity-scope L/R match JOIN (value-sweep
// 2026-07-11 `match-pair-join-no-staleness-bound`). The session pairs the
// ARRIVING side's match with the LATEST result of the other side; without a
// cutoff, a stalled side (dead worker, starved pipe) freezes one eye's center
// into the vergence law INDEFINITELY while status reads "tracking". This
// module decides, per pairing attempt, whether the partner result is still
// FRESH enough to steer on — stale ⇒ the caller treats the join as lost
// (hold, existing lost-gate semantics) and surfaces it in telemetry/status.
//
// Two independent bounds (either trips it):
//  - AGE — wall-clock ms since the partner's result arrived. The primary
//    guard: a fully wedged side stops producing seqs at all.
//  - SEQ GAP — strip-frame sequence distance between the sides. Catches a
//    LAGGING (not dead) side whose stale frames trail far behind the live
//    one — its center describes where the target WAS many frames ago.
//
// Kept next to tracker-feed.ts/vergence.ts (types-only imports, no Vue, no
// native) so vitest pins the policy without loading the session.

/** Defaults: ~12 strip frames at the ~38 fps floor ≈ 300 ms; seq gap of 12
 *  matches (the same horizon expressed in frames). Rig-tunable via the
 *  function params if the bench wants different horizons. */
export const MATCH_STALE_MS = 300;
export const MATCH_STALE_SEQ_GAP = 12;

export interface MatchFreshness {
  /** Partner side's result age (ms) — `now - partner.at`. */
  ageMs: number;
  /** `arriving.seq - partner.seq` (0/negative = partner is newer). */
  seqGap: number;
}

/** True when the PARTNER side is too stale to steer on. */
export function matchPartnerStale(
  f: MatchFreshness,
  staleMs = MATCH_STALE_MS,
  staleSeqGap = MATCH_STALE_SEQ_GAP,
): boolean {
  if (!Number.isFinite(f.ageMs) || f.ageMs < 0) return true; // corrupt clock — hold
  if (f.ageMs > staleMs) return true;
  return f.seqGap > staleSeqGap;
}
