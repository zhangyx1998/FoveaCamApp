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
  DragSlew,
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

// ---- D1 regression (docs/dev/mirror-flicker-2026-07-12.md) --------------------
// The drag flicker: THREE ~60 Hz writers rebased the compose floor during a
// drag — pointer + match slewed, but trackerFeed.onDrag pushed the RAW target
// pose, alternating the floor between two trajectories separated by the slew
// lag. Post-fix, every drag writer routes through ONE DragSlew instance (the
// production state machine below), so the rebased vPid sequence is MONOTONE
// along the slew trajectory. The pre-fix wiring is modeled explicitly to pin
// that the monotonicity detector catches exactly that failure.

describe("DragSlew — D1 drag-writer regression", () => {
  /** Linear pixel→volt map standing in for followVolts (x-only motion). */
  const follow = (px: number): SlewPose => ({
    l: { x: px * 0.01, y: 0 },
    r: { x: -px * 0.01, y: 0 },
  });

  /** Drive `steps` interleaved writer events over a target moving +8 px per
   *  event; each writer's output is a rebase — collect the floor sequence. */
  function drive(
    writers: Array<(targetPx: number) => SlewPose>,
    steps = 60,
  ): number[] {
    const rebased: number[] = [];
    let px = 100;
    for (let i = 0; i < steps; i++) {
      const writer = writers[i % writers.length]!;
      rebased.push(writer(px).l.x);
      px += 8; // moving target (~8 px per event ≈ a fast drag)
    }
    return rebased;
  }

  /** Alternation detector: a sequence that ever REGRESSES (next < prev) is
   *  flickering — a slewed approach toward a +x-moving target is monotone. */
  const regressions = (seq: number[]): number =>
    seq.filter((v, i) => i > 0 && v < seq[i - 1]! - 1e-12).length;

  it("post-fix wiring (all writers slewed through one instance) is monotone — no alternation", () => {
    let t = 0;
    const slew = new DragSlew(() => (t += 8)); // 8 ms between events
    let commanded: SlewPose = follow(100);
    const slewedWriter = (px: number): SlewPose => {
      commanded = slew.toward(commanded, follow(px));
      return commanded;
    };
    // pointer + match re-affirm: BOTH through the shared slew (the fix).
    const seq = drive([slewedWriter, slewedWriter]);
    expect(regressions(seq)).toBe(0);
    // And it genuinely tracks (not stuck): the head advanced substantially.
    expect(seq[seq.length - 1]!).toBeGreaterThan(seq[0]!);
  });

  it("pre-fix wiring (one RAW writer among slewed) ALTERNATES — the deleted onDrag push", () => {
    let t = 0;
    const slew = new DragSlew(() => (t += 8));
    let commanded: SlewPose = follow(100);
    const slewedWriter = (px: number): SlewPose => {
      commanded = slew.toward(commanded, follow(px));
      return commanded;
    };
    // The OLD onDrag: pushes followVolts(center) RAW — ahead of the slew by
    // the lag, so the floor ping-pongs raw/slewed/raw/slewed…
    const rawWriter = (px: number): SlewPose => {
      commanded = follow(px);
      return commanded;
    };
    const seq = drive([slewedWriter, rawWriter, slewedWriter]);
    expect(regressions(seq)).toBeGreaterThan(0); // the flicker signature
  });

  it("DragSlew seeds from the supplied pose once per drag and reset() re-seeds", () => {
    let t = 0;
    const slew = new DragSlew(() => (t += DRAG_SLEW_TAU_MS));
    // The SEEDING call shares its timestamp with the seed (dt = 0): it returns
    // the seed pose exactly — movement starts on the next tick (the session's
    // original closure semantics, preserved by the extraction).
    const p1 = slew.toward(follow(0), follow(100));
    expect(p1.l.x).toBe(0);
    const p2 = slew.toward(follow(0), follow(100)); // dt = τ → 1−e⁻¹ of the way
    expect(p2.l.x).toBeGreaterThan(0);
    expect(p2.l.x).toBeLessThan(1);
    slew.reset();
    const p3 = slew.toward(follow(50), follow(100));
    expect(p3.l.x).toBeCloseTo(0.5, 12); // re-seeded from the NEW pose
  });
});
