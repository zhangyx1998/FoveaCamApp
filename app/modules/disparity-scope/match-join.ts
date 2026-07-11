// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE staleness bound for the disparity-scope L/R match JOIN (spec §match-join):
// per pairing attempt, decide whether the partner result is still fresh enough to
// steer on (else the caller holds + surfaces "match stale"). Two bounds, either
// trips: AGE (wall-clock ms — a wedged side stops producing seqs) and SEQ GAP
// (a lagging side whose center describes where the target WAS). Types-only.

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
