// Coverage for the fovea-pair link helpers: which keys the pair edits as
// one, and when two L/R snapshots count as DIVERGENT (gating the pair panel
// behind the explicit unify prompt).

import { describe, expect, it } from "vitest";
import {
  PAIR_EPS_SPAN,
  PAIR_LINKED_CONTROLS,
  pairDivergence,
  type PairSideView,
} from "@lib/camera-config";

function side(overrides: Partial<PairSideView> = {}): PairSideView {
  return {
    pixel_format: "BayerRG12p",
    frame_rate_available: true,
    frame_rate_enable: false,
    frame_rate: 30,
    frame_rate_range: { min: 1, max: 60 },
    exposure_auto_available: true,
    exposure_auto: "Off",
    exposure: 8000,
    exposure_range: { min: 10, max: 100000 },
    gain_auto_available: true,
    gain_auto: "Off",
    gain: 3.5,
    gain_range: { min: 0, max: 24 },
    black_level_available: true,
    black_level_auto_available: true,
    black_level_auto: "Off",
    black_level: 1.25,
    black_level_range: { min: 0, max: 10 },
    ...overrides,
  };
}

describe("PAIR_LINKED_CONTROLS", () => {
  it("links everything except frame rate (meaningless in trigger mode)", () => {
    const keys = PAIR_LINKED_CONTROLS.map((c) => c.key);
    expect(keys).toEqual(["exposure", "gain", "black_level"]);
  });
});

describe("pairDivergence", () => {
  it("matched snapshots are not divergent", () => {
    expect(pairDivergence(side(), side())).toEqual([]);
  });

  it("flags pixel format", () => {
    expect(pairDivergence(side(), side({ pixel_format: "Mono8" }))).toEqual([
      "pixel_format",
    ]);
  });

  it("flags a differing auto mode once, without double-flagging the value", () => {
    const diffs = pairDivergence(
      side({ exposure_auto: "Off", exposure: 8000 }),
      side({ exposure_auto: "Continuous", exposure: 20000 }),
    );
    expect(diffs).toEqual(["exposure_auto"]);
  });

  it("ignores value drift while both sides are on an auto mode", () => {
    const diffs = pairDivergence(
      side({ gain_auto: "Continuous", gain: 2 }),
      side({ gain_auto: "Continuous", gain: 12 }),
    );
    expect(diffs).toEqual([]);
  });

  it("flags a manual value past the span tolerance, tolerates quantization inside it", () => {
    const span = 100000 - 10; // exposure_range span
    const inside = side({ exposure: 8000 + span * PAIR_EPS_SPAN * 0.5 });
    const outside = side({ exposure: 8000 + span * PAIR_EPS_SPAN * 2 });
    expect(pairDivergence(side(), inside)).toEqual([]);
    expect(pairDivergence(side(), outside)).toEqual(["exposure"]);
  });

  it("ignores frame-rate differences entirely", () => {
    const diffs = pairDivergence(
      side({ frame_rate: 30, frame_rate_enable: true }),
      side({ frame_rate: 60, frame_rate_enable: false }),
    );
    expect(diffs).toEqual([]);
  });

  it("skips controls unavailable on either side (nothing to link)", () => {
    const diffs = pairDivergence(
      side({ black_level_available: false, black_level: 0 }),
      side({ black_level: 9 }),
    );
    expect(diffs).toEqual([]);
  });

  it("reports every divergent key", () => {
    const diffs = pairDivergence(
      side(),
      side({ pixel_format: "Mono8", exposure: 90000, gain_auto: "Continuous" }),
    );
    expect(diffs).toEqual(["pixel_format", "exposure", "gain_auto"]);
  });
});
