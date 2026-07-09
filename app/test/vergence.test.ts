// disparity-scope's `stepVergence` control law (docs/history/refactor/orchestrator.md
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

import { PID, PID2D } from "@lib/pid";
import {
  foveaFootprintOnWide,
  foveaTileSize,
  matchMagnification,
  scopeProjection,
  seedVergence,
  stepVergence,
  type ScopeProjection,
  type VergenceControllers,
} from "@modules/disparity-scope/vergence";
import type { Point2d, Rect } from "core/Geometry";
import {
  foveaWideMagnification,
  type CoordinateConversions,
} from "@lib/coordinate-conversions";
import { distanceToVerge } from "@lib/stereo";

// Identity conversions: pixel == angle, angle == volt. Isolates the test from
// the (separately-defined, already-used-elsewhere) stereo/regression math, so
// it only verifies `stepVergence`'s own error decomposition and controller
// wiring. `P2A.C` takes the post-replumb `undistort` flag; identity ignores it.
const identityConv: Pick<CoordinateConversions, "P2A" | "A2V"> = {
  P2A: { C: (p: Point2d) => p },
  A2V: { L: (a: Point2d) => a, R: (a: Point2d) => a },
};

function rectAt(center: Point2d, size = 10): Rect {
  return { x: center.x - size / 2, y: center.y - size / 2, width: size, height: size };
}

// The scope now feeds `stepVergence` a projection (points already lifted to
// wide-frame pixels), not the strip-local analysis rects. Under `identityConv`
// the projected points ARE the center-camera angles.
function freshControllers(): VergenceControllers {
  const scalar = () => new PID({ kp: 0, ki: 1, kd: 0, limits: [-10, 10] });
  const axis = { kp: 0, ki: 1, kd: 0, limits: [-10, 10] as [number, number] };
  return {
    pan: new PID2D({ x: axis, y: axis }),
    verge: scalar(),
    v_shift: scalar(),
  };
}

function projectionFor(
  target: Point2d,
  matchedL: Point2d,
  matchedR: Point2d,
  score = 1,
  overridden = false,
): ScopeProjection {
  return {
    l: matchedL,
    r: matchedR,
    target,
    scores: { l: score, r: score },
    overridden,
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

// `scopeProjection` is the pure emission math the kernel runs to hand the
// control path its input: each strip-local match rect centre + the strip
// origin (ox, oy) = its full-resolution wide-frame position. Pins the offset
// application + score routing so a re-plumb regression can't drop them.
describe("scopeProjection (control-output emission math)", () => {
  const rect = (cx: number, cy: number, size = 10): Rect => ({
    x: cx - size / 2,
    y: cy - size / 2,
    width: size,
    height: size,
  });

  it("lifts each match rect centre by the strip origin (ox, oy) and routes scores", () => {
    const proj = scopeProjection({
      ml: { rect: rect(4, 6), score: 0.8 },
      mr: { rect: rect(10, 6), score: 0.6 },
      center: { rect: rect(7, 6) },
      ox: 100,
      oy: 50,
    });
    expect(proj.l).toEqual({ x: 104, y: 56 });
    expect(proj.r).toEqual({ x: 110, y: 56 });
    expect(proj.target).toEqual({ x: 107, y: 56 });
    expect(proj.scores).toEqual({ l: 0.8, r: 0.6 });
  });

  it("is identity on the rect centres when the strip origin is (0, 0)", () => {
    const proj = scopeProjection({
      ml: { rect: rect(3, -2), score: 1 },
      mr: { rect: rect(-5, 8), score: 1 },
      center: { rect: rect(0, 0) },
      ox: 0,
      oy: 0,
    });
    expect(proj.l).toEqual({ x: 3, y: -2 });
    expect(proj.r).toEqual({ x: -5, y: 8 });
    expect(proj.target).toEqual({ x: 0, y: 0 });
  });

  // §3.5 (controller-node-and-fifo-edges): the tracker's override flag rides
  // the projection downstream unchanged so the PID stage can act on the drag.
  it("carries the tracker-override flag through (default false)", () => {
    const input = {
      ml: { rect: rect(1, 1), score: 1 },
      mr: { rect: rect(2, 2), score: 1 },
      center: { rect: rect(0, 0) },
      ox: 0,
      oy: 0,
    };
    expect(scopeProjection(input).overridden).toBe(false);
    expect(scopeProjection(input, false).overridden).toBe(false);
    expect(scopeProjection(input, true).overridden).toBe(true);
  });
});

// §3.5 "act correspondingly": with the tracker override riding the projection
// the PID node keeps RUNNING — stepVergence must integrate toward the dragged
// target exactly as it does toward a tracked one (the flag is metadata for the
// session's status/freeze handling, never a control-math input).
describe("stepVergence on an overridden projection (drag: PID keeps running)", () => {
  it("produces the identical command for overridden and non-overridden inputs", () => {
    const target = { x: 10, y: 4 };
    const l = { x: 8, y: 2 };
    const r = { x: 12, y: 3 };
    const a = freshControllers();
    const b = freshControllers();
    const outA = stepVergence(
      projectionFor(target, l, r, 1, false),
      a,
      identityConv,
      { baseline: 200, minScore: 0.1 },
      10,
    );
    const outB = stepVergence(
      projectionFor(target, l, r, 1, true),
      b,
      identityConv,
      { baseline: 200, minScore: 0.1 },
      10,
    );
    expect(outB).toEqual(outA); // drag changes nothing in the control law
    expect(b.verge.value).toBeCloseTo(a.verge.value);
    expect(b.pan.value.x).toBeCloseTo(a.pan.value.x);
  });

  it("still holds on a low score during a drag (foveas pause until the matcher reacquires)", () => {
    const ctl = freshControllers();
    const proj = projectionFor({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }, 0.01, true);
    const out = stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(out).toBeNull();
    expect(ctl.verge.value).toBe(0); // untouched — no windup behind the hold
  });
});

// The per-eye pose markers on the wide C view must draw at the fovea FOOTPRINT
// (the magnified fovea frame shrinks onto the wide view by the app-config zoom),
// not at the full wide-frame size — user-reported marker-scaling bug.
describe("foveaFootprintOnWide (wide-view marker size)", () => {
  it("shrinks a full frame by the zoom ratio", () => {
    expect(foveaFootprintOnWide({ width: 1440, height: 1080 }, 9)).toEqual({
      width: 160,
      height: 120,
    });
    expect(foveaFootprintOnWide({ width: 1200, height: 900 }, 3)).toEqual({
      width: 400,
      height: 300,
    });
  });

  it("clamps zoom to >= 1 (a <1 zoom can't shrink the wide FOV)", () => {
    const full = { width: 1440, height: 1080 };
    expect(foveaFootprintOnWide(full, 1)).toEqual(full);
    expect(foveaFootprintOnWide(full, 0.5)).toEqual(full);
    expect(foveaFootprintOnWide(full, 0)).toEqual(full);
  });

  it("matches the sliced-center crop math (width/zoom × height/zoom)", () => {
    // The overlay footprint and the kernel's sliced crop MUST agree so the
    // markers frame exactly the tile the sliced view shows.
    for (const zoom of [1, 4, 9, 12.5]) {
      const f = foveaFootprintOnWide({ width: 1440, height: 1080 }, zoom);
      const z = Math.max(1, zoom);
      expect(f.width).toBeCloseTo(1440 / z);
      expect(f.height).toBeCloseTo(1080 / z);
    }
  });
});

// The drag-release seam (user-reported "mirror jumps to another location"):
// `seedVergence` inverts `stepVergence`'s reconstruction. A parallel drag (both
// eyes on the SAME ray) MUST seed verge/v_shift = 0; the jump was recovering the
// angles from the pinned VOLTS through the asymmetric per-eye V2A, which returns
// gL ≠ gR and fabricates a toe-in. Seeding from the KNOWN ray keeps them 0.
describe("seedVergence (drag-release reconstruction — no fabricated toe-in)", () => {
  it("a PARALLEL gaze (gL == gR) seeds verge = v_shift = 0 and pan = ray − target", () => {
    const ray = { x: 0.2, y: -0.1 };
    const aT = { x: 0.15, y: -0.05 };
    const seed = seedVergence(ray, ray, aT, 200);
    expect(seed.verge).toBe(0);
    expect(seed.v_shift).toBe(0);
    expect(seed.pan.x).toBeCloseTo(ray.x - aT.x);
    expect(seed.pan.y).toBeCloseTo(ray.y - aT.y);
  });

  it("target == drag ray ⇒ pan = 0 (resume exactly at the dragged ray)", () => {
    const ray = { x: 0.3, y: 0.05 };
    const seed = seedVergence(ray, ray, ray, 200);
    expect(seed.pan.x).toBeCloseTo(0);
    expect(seed.pan.y).toBeCloseTo(0);
    expect(seed.verge).toBe(0);
    expect(seed.v_shift).toBe(0);
  });

  it("DOCUMENTS the bug: asymmetric per-eye angles (the volt round-trip) fabricate verge + v_shift", () => {
    // A parallel drag round-tripped through independent L/R V2A regressions
    // comes back as two slightly different angles (the OLD seed path).
    const ray = { x: 0.2, y: -0.1 };
    const gL = { x: ray.x + 0.01, y: ray.y + 0.006 };
    const gR = { x: ray.x - 0.008, y: ray.y - 0.004 };
    const round = seedVergence(gL, gR, ray, 200);
    expect(Math.abs(round.verge)).toBeGreaterThan(0); // fabricated toe-in = the jump
    expect(Math.abs(round.v_shift)).toBeGreaterThan(0);
    // Seeding from the KNOWN ray instead keeps both exactly 0.
    const direct = seedVergence(ray, ray, ray, 200);
    expect(direct.verge).toBe(0);
    expect(direct.v_shift).toBe(0);
  });

  it("recovers a genuine finite verge from a truly converged pose (generic override path)", () => {
    // Build gL/gR from the forward model at distance z; the inverse returns z.
    const baseline = 200;
    const z = 1000;
    const ray = { x: 0.1, y: 0.02 };
    const b = baseline / 2;
    const x = z * Math.tan(ray.x);
    const gL = { x: Math.atan2(x + b, z), y: ray.y + 0.03 };
    const gR = { x: Math.atan2(x - b, z), y: ray.y - 0.03 };
    const seed = seedVergence(gL, gR, ray, baseline);
    expect(seed.verge).toBeCloseTo(distanceToVerge(z, baseline));
    expect(seed.v_shift).toBeCloseTo(0.03);
    expect(seed.pan.x).toBeCloseTo(0);
    expect(seed.pan.y).toBeCloseTo(0);
  });
});

// End-to-end continuity: seed the controllers from the released override, then
// run ONE stepVergence — the command must equal the pinned override volts (no
// jump), and a subsequent disparity must drive convergence.
describe("drag-release continuity (seed → step reproduces the override)", () => {
  // Asymmetric per-eye A2V so a volt round-trip WOULD fabricate vergence; P2A
  // identity (undistorted pixel == angle). stepVergence uses only P2A + A2V.
  const A2VL = (a: Point2d): Point2d => ({ x: 2 * a.x + 0.05 * a.y + 0.1, y: 3 * a.y - 0.02 });
  const A2VR = (a: Point2d): Point2d => ({ x: 1.7 * a.x - 0.03 * a.y - 0.2, y: 2.6 * a.y + 0.05 });
  const conv: Pick<CoordinateConversions, "P2A" | "A2V"> = {
    P2A: { C: (p: Point2d) => p },
    A2V: { L: A2VL, R: A2VR },
  };

  function seededControllers(seed: {
    pan: Point2d;
    verge: number;
    v_shift: number;
  }): VergenceControllers {
    const ctl = freshControllers();
    ctl.pan.value = seed.pan;
    ctl.verge.value = seed.verge;
    ctl.v_shift.value = seed.v_shift;
    return ctl;
  }

  it("first post-release command == the pinned override volts (drag: both eyes on the ray)", () => {
    const ray = { x: 12, y: -4 }; // undistorted pixel == angle (identity P2A)
    const target = ray; // the drag sets target to the drag point
    const override = { l: A2VL(ray), r: A2VR(ray) };
    // Drag-path seed: from the KNOWN ray (gL = gR = ray), not V2A(volts).
    const seed = seedVergence(ray, ray, conv.P2A.C(target, false), 200);
    const ctl = seededControllers(seed);
    // The foveas are where the override put them: both on the drag ray, so
    // their matched wide-pixel centres == the target.
    const proj = projectionFor(target, ray, ray, 1);
    const out = stepVergence(proj, ctl, conv, { baseline: 200, minScore: 0.1 }, 10);
    expect(out).not.toBeNull();
    expect(out!.left.x).toBeCloseTo(override.l.x);
    expect(out!.left.y).toBeCloseTo(override.l.y);
    expect(out!.right.x).toBeCloseTo(override.r.x);
    expect(out!.right.y).toBeCloseTo(override.r.y);
  });

  it("the fabricated-verge seed (the volt round-trip) DOES jump; the direct-ray seed does not", () => {
    const ray = { x: 5, y: 2 };
    const aT = ray;
    const override = { l: A2VL(ray), r: A2VR(ray) };
    // Eyes on the drag ray, matched at the target ⇒ zero first-step error, so
    // any command deviation is purely the seed's fabricated toe-in.
    const proj = projectionFor(ray, ray, ray, 1);

    const good = seededControllers(seedVergence(ray, ray, aT, 200));
    const outGood = stepVergence(proj, good, conv, { baseline: 200, minScore: 0.1 }, 10)!;
    const jumpGood = Math.hypot(outGood.left.x - override.l.x, outGood.right.x - override.r.x);
    expect(jumpGood).toBeLessThan(1e-9);

    // Same drag, but seeded from asymmetric per-eye angles (the volt round-trip).
    const bad = seededControllers(
      seedVergence({ x: ray.x + 0.02, y: ray.y + 0.01 }, { x: ray.x - 0.02, y: ray.y - 0.01 }, aT, 200),
    );
    const outBad = stepVergence(proj, bad, conv, { baseline: 200, minScore: 0.1 }, 10)!;
    const jumpBad = Math.hypot(outBad.left.x - override.l.x, outBad.right.x - override.r.x);
    expect(jumpBad).toBeGreaterThan(1e-3);
  });

  it("then converges: a residual disparity in the next projection steps verge toward closing it", () => {
    const ray = { x: 0, y: 0 };
    const ctl = seededControllers(seedVergence(ray, ray, ray, 200));
    // Matched R further right than L ⇒ positive verge error ⇒ eyes toe in.
    const proj = projectionFor({ x: 0, y: 0 }, { x: -3, y: 0 }, { x: 3, y: 0 }, 1);
    stepVergence(proj, ctl, conv, { baseline: 200, minScore: 0.1 }, 10);
    expect(ctl.verge.value).toBeGreaterThan(0);
  });
});

describe("stepVergence", () => {
  it("holds (returns null) and leaves the controllers untouched when either match score is below minScore", () => {
    const ctl = freshControllers();
    const proj = projectionFor({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 0.05);
    const result = stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(result).toBeNull();
    expect(ctl.verge.value).toBe(0);
    expect(ctl.pan.value.x).toBe(0);
  });

  it("commands zero correction when both eyes already match the target exactly", () => {
    const ctl = freshControllers();
    const target = { x: 5, y: -3 };
    const proj = projectionFor(target, target, target, 1);
    const result = stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(result).not.toBeNull();
    // Zero pan/verge/v_shift error -> the controllers stay at their initial
    // value, and the reconstructed ray is just the target itself (identity).
    expect(ctl.verge.value).toBeCloseTo(0);
    expect(ctl.v_shift.value).toBeCloseTo(0);
    expect(result!.left.x).toBeCloseTo(target.x);
    expect(result!.left.y).toBeCloseTo(target.y);
    expect(result!.right.x).toBeCloseTo(target.x);
  });

  it("a right-matched-further-right-than-left disparity integrates verge positively", () => {
    const ctl = freshControllers();
    const target = { x: 0, y: 0 };
    // aR.x - aL.x > 0 (see the module doc's error decomposition table).
    const proj = projectionFor(target, { x: -2, y: 0 }, { x: 2, y: 0 }, 1);
    stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(ctl.verge.value).toBeGreaterThan(0);
  });

  it("a positive (aR.y - aL.y) disparity integrates v_shift positively", () => {
    const ctl = freshControllers();
    const target = { x: 0, y: 0 };
    // eVshift = (aR.y - aL.y) / 2, fed to the controller as-is (the header
    // comment's "opposite sign" note describes how v_shift is later *applied*
    // to the two eyes' y — out.l.y = ray.y + v_shift, out.r.y = ray.y -
    // v_shift — not a negation inside stepVergence itself).
    const proj = projectionFor(target, { x: 0, y: -2 }, { x: 0, y: 2 }, 1);
    stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(ctl.v_shift.value).toBeGreaterThan(0);
  });

  it("a common-mode offset (both eyes short of the target by the same amount) drives pan, not verge", () => {
    const ctl = freshControllers();
    const target = { x: 10, y: 4 };
    const proj = projectionFor(target, { x: 8, y: 2 }, { x: 8, y: 2 }, 1);
    stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(ctl.verge.value).toBeCloseTo(0);
    expect(ctl.v_shift.value).toBeCloseTo(0);
    expect(ctl.pan.value.x).toBeGreaterThan(0);
    expect(ctl.pan.value.y).toBeGreaterThan(0);
  });

  it("dt=0 still saturates but performs no meaningful integration step", () => {
    const ctl = freshControllers();
    const proj = projectionFor({ x: 0, y: 0 }, { x: -5, y: 0 }, { x: 5, y: 0 }, 1);
    stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 0);
    expect(ctl.verge.value).toBeCloseTo(0);
  });
});
