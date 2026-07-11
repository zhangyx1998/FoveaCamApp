// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Drag slew math (value-sweep 2026-07-11 addendum `disparity-drag-slew`):
// first-order approach toward the pointer target — monotonic, converging,
// epsilon-terminating (exact target once settled, then quiet).

import { describe, expect, it } from "vitest";
import {
  DRAG_SLEW_EPSILON_V,
  DRAG_SLEW_TAU_MS,
  slewStep,
  type SlewPose,
} from "@modules/disparity-scope/drag-slew";

const pose = (v: number): SlewPose => ({ l: { x: v, y: v }, r: { x: -v, y: v } });

describe("slewStep", () => {
  it("moves toward the target by 1 − e^(−dt/τ) per step", () => {
    const r = slewStep(pose(0), pose(1), DRAG_SLEW_TAU_MS); // dt = τ
    const alpha = 1 - Math.exp(-1);
    expect(r.converged).toBe(false);
    expect(r.pose.l.x).toBeCloseTo(alpha, 9);
    expect(r.pose.r.x).toBeCloseTo(-alpha, 9);
  });

  it("is MONOTONIC — never overshoots the target", () => {
    let cur = pose(0);
    let prev = 0;
    for (let i = 0; i < 50; i++) {
      const r = slewStep(cur, pose(1), 16);
      expect(r.pose.l.x).toBeGreaterThanOrEqual(prev);
      expect(r.pose.l.x).toBeLessThanOrEqual(1);
      prev = r.pose.l.x;
      cur = r.pose;
    }
  });

  it("CONVERGES: epsilon-snaps to the EXACT target, then reports converged (quiet)", () => {
    let cur = pose(0);
    let steps = 0;
    for (; steps < 200; steps++) {
      const r = slewStep(cur, pose(1), 8);
      cur = r.pose;
      if (r.converged) break;
    }
    expect(steps).toBeLessThan(200);
    expect(cur.l.x).toBe(1); // EXACT, not approximately
    expect(cur.r.x).toBe(-1);
    // A converged pose stays converged — successive identical outputs are the
    // "go quiet" contract (the sink gate dedupes them away).
    const again = slewStep(cur, pose(1), 8);
    expect(again.converged).toBe(true);
    expect(again.pose).toEqual(cur);
  });

  it("perceived latency stays ~1-2 pointer intervals (86%+ after 2×τ)", () => {
    const r1 = slewStep(pose(0), pose(1), 2 * DRAG_SLEW_TAU_MS);
    expect(r1.pose.l.x).toBeGreaterThan(0.86);
  });

  it("dt <= 0 holds the pose (a duplicate-timestamp tick moves nothing)", () => {
    const r = slewStep(pose(0.3), pose(1), 0);
    expect(r.pose.l.x).toBeCloseTo(0.3, 12);
    expect(r.converged).toBe(false);
  });

  it("within-epsilon start snaps immediately", () => {
    const near = pose(1 - DRAG_SLEW_EPSILON_V / 2);
    const r = slewStep(near, pose(1), 8);
    expect(r.converged).toBe(true);
    expect(r.pose.l.x).toBe(1);
  });
});
