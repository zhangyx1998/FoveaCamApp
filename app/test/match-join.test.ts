// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// L/R match-join staleness bound (value-sweep 2026-07-11
// `match-pair-join-no-staleness-bound`): a stalled side must read as LOST,
// not steer one frozen eye forever.

import { describe, expect, it } from "vitest";
import {
  matchPartnerStale,
  MATCH_STALE_MS,
  MATCH_STALE_SEQ_GAP,
} from "@modules/disparity-scope/match-join";

describe("matchPartnerStale", () => {
  it("fresh partner (small age, small gap) steers", () => {
    expect(matchPartnerStale({ ageMs: 30, seqGap: 1 })).toBe(false);
    expect(matchPartnerStale({ ageMs: 0, seqGap: 0 })).toBe(false);
  });

  it("a DEAD side trips the age bound even with a small seq gap", () => {
    expect(matchPartnerStale({ ageMs: MATCH_STALE_MS + 1, seqGap: 1 })).toBe(true);
    expect(matchPartnerStale({ ageMs: MATCH_STALE_MS, seqGap: 1 })).toBe(false); // boundary
  });

  it("a LAGGING side trips the seq bound even while still producing", () => {
    expect(matchPartnerStale({ ageMs: 50, seqGap: MATCH_STALE_SEQ_GAP + 1 })).toBe(true);
    expect(matchPartnerStale({ ageMs: 50, seqGap: MATCH_STALE_SEQ_GAP })).toBe(false); // boundary
  });

  it("a partner NEWER than the arriving side (negative gap) is never seq-stale", () => {
    expect(matchPartnerStale({ ageMs: 50, seqGap: -3 })).toBe(false);
  });

  it("a corrupt clock (negative / non-finite age) holds rather than steering", () => {
    expect(matchPartnerStale({ ageMs: -5, seqGap: 0 })).toBe(true);
    expect(matchPartnerStale({ ageMs: NaN, seqGap: 0 })).toBe(true);
  });

  it("custom horizons apply", () => {
    expect(matchPartnerStale({ ageMs: 100, seqGap: 0 }, 80)).toBe(true);
    expect(matchPartnerStale({ ageMs: 100, seqGap: 5 }, 200, 4)).toBe(true);
  });
});
