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
  foveaTileSize,
  matchMagnification,
  stepVergence,
  type VergenceAnalysis,
  type VergencePIDs,
} from "@modules/disparity-scope/vergence";
import type { Point2d, Rect } from "core/Geometry";
import {
  foveaWideMagnification,
  type CoordinateConversions,
} from "@lib/coordinate-conversions";

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

// The fovea↔wide template match is only meaningful when the fovea tile and the
// wide guide strip render the SAME angular content at the SAME pixel scale. The
// fovea frame spans the wide FOV divided by the magnification `zoom`, so in
// wide-frame pixels it covers `width / zoom`; the guide strip is downsampled by
// `scale`, so that same footprint is `(width / zoom) * scale` strip pixels. The
// fovea tile MUST be resized to exactly that many pixels — i.e. `foveaTileSize`
// must apply the magnification identically to both sides. These pin that
// invariant so a regression that dropped `zoom` from one side (matching a
// full-resolution fovea against an un-demagnified strip — the "same pixel scale"
// class of bug) can't pass silently.
//
// NOTE (audit 2026-07): the magnification used here is the session's nominal
// `zoom` STATE (default 9.0), not the calibration-measured fovea/wide ratio
// (`findPinholeProjection` measures it as `scale` but discards it). The math is
// self-consistent for any `zoom`; correctness of the *absolute* scale still
// hinges on `zoom` matching the real optics — see docs/applications/
// disparity-scope.md.
describe("foveaTileSize (fovea↔wide match scale-consistency)", () => {
  const stripFootprintPx = (width: number, zoom: number, scale: number) =>
    (width / zoom) * scale;

  it("resizes the fovea tile to the strip footprint of one fovea frame", () => {
    for (const zoom of [1, 4, 9, 12.5]) {
      for (const scale of [1, 3, 9]) {
        const { width, height } = foveaTileSize({
          width: 1440,
          height: 1080,
          zoom,
          scale,
        });
        expect(width).toBeCloseTo(stripFootprintPx(1440, zoom, scale));
        expect(height).toBeCloseTo(stripFootprintPx(1080, zoom, scale));
      }
    }
  });

  it("keeps tile:strip pixel ratio at 1:1 regardless of zoom (both demagnify by zoom)", () => {
    // A fixed physical patch spanning `wPx` wide-frame pixels lands on the strip
    // as `wPx * scale` px and on the fovea tile as `wPx * scale` px too — the
    // `zoom` factor cancels between the two sides. If it didn't cancel, CCOEFF
    // template matching (not scale-invariant) would fail.
    const scale = 3;
    const wPx = 20; // a patch 20 wide-pixels across
    for (const zoom of [1, 6, 9, 15]) {
      const tile = foveaTileSize({ width: 1440, height: 1080, zoom, scale });
      const tilePxPerWidePx = tile.width / (1440 / zoom); // fovea-frame → tile
      const stripPxPerWidePx = scale; // wide strip downsample factor
      expect(tilePxPerWidePx * wPx).toBeCloseTo(stripPxPerWidePx * wPx);
    }
  });
});

// The measured-magnification plumbing (user-reported bug (a), decision taken
// 2026-07-08): `foveaWideMagnification` derives the true fovea↔wide ratio from
// the extrinsic fit's measured `scale` (fovea px per object-unit at the
// protocol's nominal 1000-unit distance) and the wide focal length;
// `matchMagnification` then selects measured-over-nominal with a legacy-exact
// fallback. Session and kernel both route through `matchMagnification`, so
// these pin the entire selection behavior.
describe("foveaWideMagnification (measured ratio derivation)", () => {
  it("derives scale·1000/mean(focal)", () => {
    // scale = 9 fovea px per unit at 1000 units; wide focal 1000 px sees that
    // unit as 1 px → magnification 9.
    expect(foveaWideMagnification(9, { x: 1000, y: 1000 })).toBeCloseTo(9);
    // Anisotropic focal uses the mean: (800+1200)/2 = 1000.
    expect(foveaWideMagnification(9, { x: 800, y: 1200 })).toBeCloseTo(9);
    expect(foveaWideMagnification(4.5, { x: 500, y: 500 })).toBeCloseTo(9);
  });

  it("returns null for missing/degenerate inputs (legacy fits, uncalibrated wide)", () => {
    expect(foveaWideMagnification(undefined, { x: 1000, y: 1000 })).toBeNull();
    expect(foveaWideMagnification(0, { x: 1000, y: 1000 })).toBeNull();
    expect(foveaWideMagnification(-3, { x: 1000, y: 1000 })).toBeNull();
    expect(foveaWideMagnification(NaN, { x: 1000, y: 1000 })).toBeNull();
    expect(foveaWideMagnification(9, null)).toBeNull();
    expect(foveaWideMagnification(9, undefined)).toBeNull();
    expect(foveaWideMagnification(9, { x: 0, y: 0 })).toBeNull();
    expect(foveaWideMagnification(9, { x: NaN, y: NaN })).toBeNull();
  });
});

describe("matchMagnification (measured-vs-fallback selection)", () => {
  it("prefers the measured magnification when present", () => {
    expect(matchMagnification(8.7, 9)).toBe(8.7);
    // Even when the nominal knob disagrees wildly — the knob must no longer
    // influence the match on calibrated rigs.
    expect(matchMagnification(8.7, 1)).toBe(8.7);
    expect(matchMagnification(8.7, 42)).toBe(8.7);
  });

  it("falls back to the nominal zoom when unmeasured (legacy-exact)", () => {
    expect(matchMagnification(null, 9)).toBe(9);
    expect(matchMagnification(undefined, 9)).toBe(9);
    // Degenerate measured values also fall back rather than poisoning the match.
    expect(matchMagnification(0, 9)).toBe(9);
    expect(matchMagnification(-1, 9)).toBe(9);
    expect(matchMagnification(NaN, 9)).toBe(9);
    expect(matchMagnification(Infinity, 9)).toBe(9);
  });

  it("clamps the nominal fallback to >= 1, matching the session/kernel's old Math.max(1, zoom)", () => {
    expect(matchMagnification(null, 0.5)).toBe(1);
    expect(matchMagnification(null, 0)).toBe(1);
    expect(matchMagnification(null, -2)).toBe(1);
  });

  it("feeds foveaTileSize consistently in both modes (tile:strip stays 1:1)", () => {
    // Same invariant as the scale-consistency suite above, exercised through
    // the selection: whichever magnification wins, BOTH the tile and the strip
    // divide by it, so the pixel-scale agreement is preserved.
    for (const [measured, nominal] of [
      [8.62, 9], // measured drives
      [null, 9], // fallback drives
    ] as const) {
      const zoom = matchMagnification(measured, nominal);
      const tile = foveaTileSize({ width: 1440, height: 1080, zoom, scale: 3 });
      expect(tile.width).toBeCloseTo((1440 / zoom) * 3);
      expect(tile.height).toBeCloseTo((1080 / zoom) * 3);
    }
  });
});

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
