// disparity-scope's `stepVergence` control law (docs/refactor/orchestrator.md
// §7.1 S1a — the §1 flagship migration). `analyzeVergence`/`getFoveaTile` are
// native-Vision-backed (real template matching against real frames) and not
// practically unit-testable here; `stepVergence` is the actual new risk
// surface this migration ports (error decomposition, PID wiring, sign
// conventions, low-score hold behavior) and is pure math over a synthetic
// `VergenceAnalysis` — exactly "the vergence math with synthetic frames"
// stands in for here: synthetic *analysis results* (a matched-rect pair +
// score), decoupled from how they'd be produced by real template matching.
//
// `core/Vision`'s ops are mocked to trivial stubs (same pattern as
// `manual-control-capture.test.ts`) purely so importing `vergence.ts` at all
// doesn't require the native addon — `stepVergence` never calls any of them.

import { describe, expect, it, vi } from "vitest";

vi.mock("core/Vision", () => ({
  cvtColor: vi.fn(),
  gaussian: vi.fn(),
  heatmap: vi.fn(),
  matchTemplate: vi.fn(),
  minMaxLoc: vi.fn(),
  resize: vi.fn(),
  slice: vi.fn(),
}));

import { PID } from "@lib/pid";
import {
  stepVergence,
  type VergenceAnalysis,
  type VergencePIDs,
} from "@modules/disparity-scope/vergence";
import type { Point2d, Rect } from "core/Geometry";
import type { CoordinateConversions } from "@lib/coordinate-conversions";

// Identity conversions: pixel == angle, angle == volt. Isolates the test from
// the (separately-defined, already-used-elsewhere) stereo/regression math, so
// it only verifies `stepVergence`'s own error decomposition and PID wiring.
const identityConv: Pick<CoordinateConversions, "P2A" | "A2V"> = {
  P2A: { C: (p: Point2d) => p },
  A2V: { L: (a: Point2d) => a, R: (a: Point2d) => a },
};

function rectAt(center: Point2d, size = 10): Rect {
  return { x: center.x - size / 2, y: center.y - size / 2, width: size, height: size };
}

function freshPids(): VergencePIDs {
  return {
    verge: new PID({ kp: 0, ki: 1, kd: 0, limits: [-10, 10] }),
    v_shift: new PID({ kp: 0, ki: 1, kd: 0, limits: [-10, 10] }),
    panX: new PID({ kp: 0, ki: 1, kd: 0, limits: [-10, 10] }),
    panY: new PID({ kp: 0, ki: 1, kd: 0, limits: [-10, 10] }),
  };
}

function analysisFor(target: Point2d, matchedL: Point2d, matchedR: Point2d, score = 1): VergenceAnalysis {
  return {
    guide: undefined as any, // unused by stepVergence
    ml: { mat: undefined as any, rect: rectAt(matchedL), score },
    mr: { mat: undefined as any, rect: rectAt(matchedR), score },
    center: { rect: rectAt(target) },
    ox: 0,
    oy: 0,
  };
}

describe("stepVergence", () => {
  it("holds (returns null) and leaves the PIDs untouched when either match score is below minScore", () => {
    const pids = freshPids();
    const analysis = analysisFor({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 0.05);
    const result = stepVergence(analysis, pids, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(result).toBeNull();
    expect(pids.verge.value).toBe(0);
    expect(pids.panX.value).toBe(0);
  });

  it("commands zero correction when both eyes already match the target exactly", () => {
    const pids = freshPids();
    const target = { x: 5, y: -3 };
    const analysis = analysisFor(target, target, target, 1);
    const result = stepVergence(analysis, pids, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(result).not.toBeNull();
    // Zero pan/verge/v_shift error -> the PIDs stay at their initial value,
    // and the reconstructed ray is just the target itself (identity convs).
    expect(pids.verge.value).toBeCloseTo(0);
    expect(pids.v_shift.value).toBeCloseTo(0);
    expect(result!.left.x).toBeCloseTo(target.x);
    expect(result!.left.y).toBeCloseTo(target.y);
    expect(result!.right.x).toBeCloseTo(target.x);
  });

  it("a right-matched-further-right-than-left disparity integrates verge positively", () => {
    const pids = freshPids();
    const target = { x: 0, y: 0 };
    // aR.x - aL.x > 0 (see the module doc's error decomposition table).
    const analysis = analysisFor(target, { x: -2, y: 0 }, { x: 2, y: 0 }, 1);
    stepVergence(analysis, pids, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(pids.verge.value).toBeGreaterThan(0);
  });

  it("a positive (aR.y - aL.y) disparity integrates v_shift positively", () => {
    const pids = freshPids();
    const target = { x: 0, y: 0 };
    // eVshift = (aR.y - aL.y) / 2, fed to the PID as-is (the header comment's
    // "opposite sign" note describes how v_shift is later *applied* to the
    // two eyes' y — out.l.y = ray.y + v_shift, out.r.y = ray.y - v_shift —
    // not a negation inside stepVergence itself). Pins the sign so a future
    // refactor can't silently flip it.
    const analysis = analysisFor(target, { x: 0, y: -2 }, { x: 0, y: 2 }, 1);
    stepVergence(analysis, pids, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(pids.v_shift.value).toBeGreaterThan(0);
  });

  it("a common-mode offset (both eyes short of the target by the same amount) drives pan, not verge", () => {
    const pids = freshPids();
    const target = { x: 10, y: 4 };
    const analysis = analysisFor(target, { x: 8, y: 2 }, { x: 8, y: 2 }, 1);
    stepVergence(analysis, pids, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(pids.verge.value).toBeCloseTo(0);
    expect(pids.v_shift.value).toBeCloseTo(0);
    expect(pids.panX.value).toBeGreaterThan(0);
    expect(pids.panY.value).toBeGreaterThan(0);
  });

  it("dt=0 still saturates but performs no meaningful integration step", () => {
    const pids = freshPids();
    const analysis = analysisFor({ x: 0, y: 0 }, { x: -5, y: 0 }, { x: 5, y: 0 }, 1);
    stepVergence(analysis, pids, identityConv, { baseline: 200, minScore: 0.1 }, 0);
    expect(pids.verge.value).toBeCloseTo(0);
  });
});
