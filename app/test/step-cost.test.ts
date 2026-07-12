// Scripted-step trace cost (docs/proposals/vergence-loop-tuning.md §1 — the
// CMA-ES polish objective): ITAE + overshoot penalty + actuation effort on
// synthetic traces. The ORDERING properties are what the optimizer relies on.

import { describe, expect, it } from "vitest";
import {
  stepCost,
  regulationCost,
  DEFAULT_STEP_WEIGHTS,
  MIN_TRACE_SAMPLES,
  UNMEASURABLE_COST,
  type StepTraceSample,
} from "@modules/disparity-scope/step-cost";

function trace(
  error: (t: number) => number,
  command: (t: number) => number = () => 0,
  T = 100,
): StepTraceSample[] {
  return Array.from({ length: T + 1 }, (_, t) => ({
    t,
    error: error(t),
    command: command(t),
  }));
}

describe("stepCost (ordering properties)", () => {
  it("a fast decay costs less than a slow one (ITAE)", () => {
    const fast = stepCost(trace((t) => Math.exp(-t / 3)));
    const slow = stepCost(trace((t) => Math.exp(-t / 20)));
    expect(fast).toBeLessThan(slow);
    expect(fast).toBeGreaterThan(0);
  });

  it("overshoot past zero is penalized beyond its ITAE contribution", () => {
    const damped = (t: number) => Math.exp(-t / 5);
    // Same envelope, but with an opposite-sign dip (the ringing shape).
    const ringing = (t: number) =>
      t >= 10 && t <= 20 ? -0.5 : Math.exp(-t / 5);
    const a = stepCost(trace(damped));
    const b = stepCost(trace(ringing));
    expect(b).toBeGreaterThan(a);
    // The quadratic overshoot term alone exceeds the dip's ITAE share.
    const noPenalty = stepCost(trace(ringing), { overshoot: 0, effort: 0 });
    expect(b - noPenalty).toBeCloseTo(DEFAULT_STEP_WEIGHTS.overshoot * 0.5 ** 2);
  });

  it("actuation effort (command total variation) raises the cost", () => {
    const e = (t: number) => Math.exp(-t / 5);
    const calm = stepCost(trace(e, () => 1));
    const jittery = stepCost(trace(e, (t) => (t % 2 === 0 ? 1 : 1.2)));
    expect(jittery).toBeGreaterThan(calm);
  });

  it("normalizes by the observed peak — a pipeline-delay lead-in of zeros is fine", () => {
    const delayed = (t: number) => (t < 8 ? 0 : Math.exp(-(t - 8) / 5));
    const cost = stepCost(trace(delayed));
    expect(Number.isFinite(cost)).toBe(true);
    // Explicit ref equal to the peak matches the default.
    expect(stepCost(trace(delayed), DEFAULT_STEP_WEIGHTS, 1)).toBeCloseTo(cost);
  });

  it("is scale-invariant in the error/command units", () => {
    const e = (t: number) => Math.exp(-t / 5);
    const u = (t: number) => 1 - Math.exp(-t / 5);
    const a = stepCost(trace(e, u));
    const b = stepCost(trace((t) => 40 * e(t), (t) => 40 * u(t)));
    expect(b).toBeCloseTo(a);
  });

  it("degenerate traces are UNMEASURABLE, never NaN/throw", () => {
    expect(stepCost([])).toBe(UNMEASURABLE_COST);
    expect(stepCost(trace(() => 1, () => 0, MIN_TRACE_SAMPLES - 3))).toBe(
      UNMEASURABLE_COST,
    );
    expect(stepCost(trace(() => 0))).toBe(UNMEASURABLE_COST); // zero peak
  });
});

describe("regulationCost (cross-coupling term)", () => {
  it("is the mean |error| per unit reference", () => {
    const tr = trace((t) => (t % 2 === 0 ? 0.2 : -0.2), () => 0, 9);
    expect(regulationCost(tr, 2)).toBeCloseTo(0.1);
  });

  it("degenerates to 0 on empty traces / non-positive refs", () => {
    expect(regulationCost([], 1)).toBe(0);
    expect(regulationCost(trace(() => 1), 0)).toBe(0);
  });
});
