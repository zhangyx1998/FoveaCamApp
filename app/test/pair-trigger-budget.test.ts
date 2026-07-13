// Coverage for the fovea-pair trigger budget (P6): the ONE derivation both
// multi-fovea (pulse + scheduler pacing) and manage-cameras (readout row) use.
// The exposure-vs-pulse authority flip point lives inside this function — see
// the AUTHORITY comment in @lib/camera-config.

import { describe, expect, it } from "vitest";
import { TRIGGER_FRAME_MARGIN_US, pairTriggerBudget } from "@lib/camera-config";

describe("pairTriggerBudget", () => {
  it("pulse covers the slower eye's exposure, in WIRE µs (never scaled ×1000)", () => {
    const exposureUsR = 12000;
    const b = pairTriggerBudget({ exposureUsL: 8000, exposureUsR });
    // `FrameArg.pulse` is microseconds — the pulse IS the exposure µs, verbatim.
    // A ×1000 here (the trigger-freeze bug: 16.7 ms → 16.7 s) would fail this.
    expect(b.pulseUs).toBe(Math.round(exposureUsR));
  });

  it("interval = settle + exposure + margin when no readout rate is known", () => {
    const b = pairTriggerBudget({
      exposureUsL: 10000,
      exposureUsR: 4000,
      settleUs: 2000,
    });
    expect(b.minIntervalMs).toBeCloseTo((2000 + 10000 + TRIGGER_FRAME_MARGIN_US) / 1000, 9);
  });

  it("camera-reported readout floor binds when exposure is short", () => {
    // 1 ms exposure but the camera tops out at 100 Hz → 10 ms frame floor.
    const b = pairTriggerBudget({
      exposureUsL: 1000,
      exposureUsR: 1000,
      maxRateHzL: 100,
      maxRateHzR: 250,
    });
    expect(b.minIntervalMs).toBeCloseTo((10000 + TRIGGER_FRAME_MARGIN_US) / 1000, 9);
  });

  it("exposure and readout floor take the max, never the sum (they overlap)", () => {
    const b = pairTriggerBudget({
      exposureUsL: 20000,
      exposureUsR: 20000,
      maxRateHzL: 100, // 10 ms readout period < 20 ms exposure
      maxRateHzR: 100,
    });
    expect(b.minIntervalMs).toBeCloseTo((20000 + TRIGGER_FRAME_MARGIN_US) / 1000, 9);
  });

  it("the slower camera paces the pair", () => {
    const b = pairTriggerBudget({
      exposureUsL: 1000,
      exposureUsR: 1000,
      maxRateHzL: 500, // 2 ms
      maxRateHzR: 50, // 20 ms — binds
    });
    expect(b.minIntervalMs).toBeCloseTo((20000 + TRIGGER_FRAME_MARGIN_US) / 1000, 9);
  });

  it("maxRateHz is the inverse of minIntervalMs", () => {
    const b = pairTriggerBudget({ exposureUsL: 5000, exposureUsR: 7000, settleUs: 500 });
    expect(b.maxRateHz * b.minIntervalMs).toBeCloseTo(1000, 6);
  });

  it("tolerates garbage inputs (NaN / negative / undefined) without going non-finite", () => {
    const b = pairTriggerBudget({
      exposureUsL: NaN,
      exposureUsR: -5,
      settleUs: Number.POSITIVE_INFINITY,
      maxRateHzL: 0,
      maxRateHzR: NaN,
    });
    expect(b.pulseUs).toBe(0);
    // Everything unknowable → the stated margin is the whole budget.
    expect(b.minIntervalMs).toBeCloseTo(TRIGGER_FRAME_MARGIN_US / 1000, 9);
    expect(Number.isFinite(b.maxRateHz)).toBe(true);
  });
});
