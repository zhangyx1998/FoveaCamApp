// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PID limit re-bounding (value-sweep 2026-07-11 `verge-integral-clamp-stale`):
// the constructor aliases `integralLimits` to the `limits` ARRAY when no
// explicit integral clamp is given — a later bare `.limits = [...]` left the
// integrator (the COMMAND, in velocity form) clamped to the construction-time
// bound. `setLimits` updates both and re-clamps the live integrator.

import { describe, expect, it } from "vitest";
import { DERIVATIVE_TAU, PID } from "@lib/pid";

/** The disparity verge shape: velocity-form (kp = kd = 0, integrator = the
 *  command), constructed against the DEFAULT 200 mm baseline bound. */
const VERGE_AT_200MM = 0.5; // stand-in for distanceToVerge(150, 200)
const VERGE_AT_400MM = 1.0; // a 400 mm rig resolves a WIDER verge range

describe("PID.setLimits (verge-integral-clamp-stale)", () => {
  it("REGRESSION: a bare `.limits =` leaves the integrator clamped to the construction bound", () => {
    const pid = new PID({ ki: 1, limits: [0, VERGE_AT_200MM] });
    pid.limits = [0, VERGE_AT_400MM]; // the OLD two-site pattern
    for (let i = 0; i < 100; i++) pid.step(1, 1); // drive toward the new bound
    // The command saturates at the STALE construction-time bound — the defect.
    expect(pid.value).toBe(VERGE_AT_200MM);
  });

  it("setLimits widens BOTH bounds — the 400 mm-baseline rig gets its full range", () => {
    const pid = new PID({ ki: 1, limits: [0, VERGE_AT_200MM] });
    pid.setLimits([0, VERGE_AT_400MM]);
    for (let i = 0; i < 100; i++) pid.step(1, 1);
    expect(pid.value).toBe(VERGE_AT_400MM); // integrates to the NEW bound
    expect(pid.limits).toEqual([0, VERGE_AT_400MM]);
    expect(pid.integralLimits).toEqual([0, VERGE_AT_400MM]);
  });

  it("setLimits narrows: the live command re-clamps immediately (no stale out-of-range value)", () => {
    const pid = new PID({ ki: 1, limits: [0, VERGE_AT_400MM] });
    for (let i = 0; i < 100; i++) pid.step(1, 1);
    expect(pid.value).toBe(VERGE_AT_400MM);
    pid.setLimits([0, VERGE_AT_200MM]);
    expect(pid.value).toBe(VERGE_AT_200MM);
  });

  it("an explicit integralLimits stays independent of the output bound", () => {
    const pid = new PID({ ki: 1, limits: [0, 10] });
    pid.setLimits([0, 10], [0, 2]); // anti-windup tighter than output
    for (let i = 0; i < 100; i++) pid.step(1, 1);
    expect(pid.value).toBe(2);
  });
});

// The kd explosion (auto-vergence 2026-07-12): the raw derivative `Δe/dt` is
// the one PID term that DIVIDES by dt, so a near-zero-dt step (the match
// join's intra-frame re-pair) kicked the output by an unbounded amount for ANY
// kd ≠ 0. The derivative is now low-passed with α = dt/(dt + dTau) — a tiny-dt
// step contributes ~nothing, and a step train converges to the true slope.
describe("PID derivative filter (kd-explosion regression)", () => {
  it("REGRESSION SHAPE: a near-zero-dt step no longer amplifies Δe by 1/dt", () => {
    const pid = new PID({ kd: 0.02 });
    pid.step(0, 1); // prime prevError
    // Raw slope would be 0.001/1e-3 = 1 → output 0.02; filtered: α ≈ 5e-4,
    // so the contribution collapses by ~3 orders of magnitude.
    const out = pid.step(0.001, 1e-3);
    expect(Math.abs(out)).toBeLessThan(0.02 * 1e-2);
  });

  it("converges to the true slope over ~dTau of uniform steps", () => {
    const pid = new PID({ kd: 1 });
    let out = 0;
    // error ramps at slope 2; after many τ the filtered slope ≈ 2 → output ≈ kd·2.
    for (let i = 0; i < 50; i++) out = pid.step(2 * i, 1);
    expect(out).toBeCloseTo(2, 3);
  });

  it("a long gap re-converges immediately (α → 1 for dt ≫ dTau)", () => {
    const pid = new PID({ kd: 1 });
    pid.step(0, 1);
    const out = pid.step(100 * DERIVATIVE_TAU, 100 * DERIVATIVE_TAU);
    expect(out).toBeCloseTo(1, 1); // slope 1, α ≈ 0.98
  });

  it("dTau = 0 degenerates to the raw, unfiltered slope", () => {
    const pid = new PID({ kd: 1, dTau: 0 });
    pid.step(0, 1);
    expect(pid.step(3, 1)).toBe(3);
  });

  it("reset clears the filter state alongside the derivative memory", () => {
    const pid = new PID({ kd: 1 });
    for (let i = 0; i < 50; i++) pid.step(5 * i, 1); // spin the filter up
    pid.reset();
    pid.step(0, 1); // re-prime prevError
    expect(pid.step(0, 1)).toBe(0); // zero slope → zero output, no residue
  });
});
