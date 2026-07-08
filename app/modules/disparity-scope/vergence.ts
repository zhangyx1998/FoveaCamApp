// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Auto-vergence: drive both fovea cameras to fixate the same physical point.
//
// Each frame triple is processed in two stages:
//
//   1. analyzeVergence() — template-match each fovea tile into a strip taken
//      from the wide center frame to find where each fovea is *actually*
//      looking, in wide-frame pixels.
//   2. stepVergence() — constrained proportional control on {pan, verge,
//      v_shift}, reconstructing both fovea poses symmetrically about the gaze
//      ray, returning new actuator voltages.
//
// The loop feeds back on the image-matched position rather than the
// calibration-predicted one, so a constant extrinsic-calibration offset is
// absorbed by the loop instead of biasing convergence.

import type { Point2d, Rect, Size } from "core/Geometry";
import {
  cvtColor,
  gaussian,
  heatmap,
  Mat,
  matchTemplate,
  minMaxLoc,
  resize,
  slice,
} from "core/Vision";
import { RECT, VEC } from "@lib/util/geometry";
import { PID } from "@lib/pid";
import { inverseTriangulate, vergeToDistance } from "@lib/stereo";
import type { CoordinateConversions } from "@lib/coordinate-conversions";

export type MatchResult = {
  /** Heatmap visualization of the correlation map (red = match). */
  mat: Mat<Uint8Array>;
  /** Matched fovea footprint within the guide strip, full-resolution pixels. */
  rect: Rect;
  /** CCOEFF_NORMED peak score in [-1, 1]; higher = more confident. */
  score: number;
};

export type VergenceAnalysis = {
  /** Full-resolution wide strip used as the match guide. */
  guide: Mat<Uint8Array>;
  ml: MatchResult;
  mr: MatchResult;
  /** Target footprint within the guide strip. */
  center: { rect: Rect };
  /** Position of the top left corner of the guide strip on wide frame */
  ox: number;
  oy: number;
};

/** The scalar subset of {@link VergenceAnalysis} that {@link stepVergence}
 *  actually reads (no Mats). C-22b: the vision worker computes the analysis and
 *  posts only these fields back over the MessagePort; the main-thread control
 *  step consumes them. A full `VergenceAnalysis` is structurally assignable. */
export type VergenceStepInput = {
  ml: Pick<MatchResult, "rect" | "score">;
  mr: Pick<MatchResult, "rect" | "score">;
  center: { rect: Rect };
  ox: number;
  oy: number;
};

export type VergenceOptions = {
  /** Wide center frame dimensions (pixels). */
  width: number;
  height: number;
  /** Zoom ratio = FOV(wide) / FOV(fovea). */
  zoom: number;
  /** Scale of the fovea tiles (1.0 ~ zoom); higher = more detail, more compute. */
  scale: number;
  /** Target center within the wide frame (pixels). */
  target: Point2d;
  /** Expansion factor for the match strip. */
  expand_x: number;
  expand_y: number;
};

/** Fovea tile size at a given wide-frame footprint (matches `analyzeVergence`'s
 *  own math) — callers precompute tiles at this size via `getFoveaTile`. */
export function foveaTileSize(opts: Pick<VergenceOptions, "width" | "height" | "zoom" | "scale">): Size {
  const { width, height, zoom: z, scale: s } = opts;
  return { width: (width * s) / z, height: (height * s) / z };
}

/**
 * The magnification that drives the fovea↔wide template match: the
 * calibration-MEASURED fovea/wide ratio when one is available (see
 * `foveaWideMagnification`, @lib/coordinate-conversions — CCOEFF template
 * matching is not scale invariant, so the true optical ratio matters), else
 * the nominal UI zoom clamped to ≥ 1 — exactly the pre-measurement behavior,
 * so legacy/uncalibrated rigs regress nowhere.
 */
export function matchMagnification(
  measured: number | null | undefined,
  nominalZoom: number,
): number {
  return measured != null && Number.isFinite(measured) && measured > 0
    ? measured
    : Math.max(1, nominalZoom);
}

/**
 * Per-DOF controllers. Rather than commanding the four fovea pixel DOF
 * (L.x, L.y, R.x, R.y) independently — which lets the foveas drift apart on
 * noisy frames — the loop integrates these physically-meaningful DOF
 * (each a {@link PID} whose clamped integrator is the command) and reconstructs
 * both fovea poses symmetrically about the gaze ray.
 */
export type VergencePIDs = {
  /** Inverse-√depth verge parameter (0 ⇒ ∞, larger ⇒ nearer). */
  verge: PID;
  /** Vertical half-shift between the foveas (rad). */
  v_shift: PID;
  /** Common-mode ray correction, x/y (rad). */
  panX: PID;
  panY: PID;
};

export type VergenceControl = {
  /** Inter-fovea baseline (mm). */
  baseline: number;
  /** Minimum match score in [-1, 1] required to trust a correction. */
  minScore: number;
};

// Smoothing applied to each correlation map before peak-finding, so a single
// noisy pixel can't win over a broader, more confident lobe.
const GAUSS_KSIZE = 9;
const GAUSS_SIGMA = 10;

/**
 * Grayscale, downsampled fovea tile at its wide-frame footprint size. Exported
 * so callers driven by per-camera frame taps (the orchestrator registry's
 * `onView`, whose Mat is only valid for the duration of that synchronous
 * call) can compute a tile — safe to retain past the call, since `cvtColor`
 * reads the source and allocates a fresh buffer before this function's first
 * `await` — independently of the other eye's tick, then hand the pair to
 * {@link analyzeVergence} once the center tick arrives. See
 * docs/history/refactor/orchestrator.md §7.1 S1a.
 */
export async function getFoveaTile(f: Mat<Uint8Array>, size: Size) {
  return await resize(cvtColor(f, "RGBA2GRAY"), size);
}

/** Grayscale horizontal strip from the wide frame, scaled by `s`. */
async function getMatchTile(
  f: Mat<Uint8Array>,
  ox: number,
  oy: number,
  W: number,
  H: number,
  s: number,
) {
  const m = cvtColor(f, "RGBA2GRAY");
  const sliced = slice(m, { x: ox, y: oy, width: W, height: H });
  return await resize(sliced, {}, s, s);
}

/**
 * Locate the correlation peak and un-scale it back to full-resolution strip
 * coordinates (`s` is the inverse of the strip's scale factor).
 */
async function processMatch(
  match: Mat<Float32Array>,
  needle: Mat,
  s: number,
): Promise<MatchResult> {
  const { max } = minMaxLoc(match);
  const [height = 0, width = 0] = needle.shape;
  const rect = RECT.fromTopLeft(max, { width, height });
  const [h1 = 0, w1 = 0] = match.shape;
  const [, w2 = 0] = needle.shape;
  const sliced = slice(match, {
    x: -w2 / 2,
    y: 0,
    width: w1 + w2 * 2,
    height: h1,
  });
  const resized = await resize(sliced, {}, s);
  return {
    mat: heatmap(resized),
    rect: VEC.mul(rect, s),
    score: max.value,
  };
}

/**
 * Stage 1: template-match each fovea tile into the wide-frame strip and report
 * where each fovea is currently looking, plus the target footprint.
 *
 * `tiles` are precomputed per-eye via {@link getFoveaTile} (see that
 * function's doc for why — the registry's per-camera `onView` taps don't
 * arrive synchronized, so each eye's tile is captured independently on its
 * own tick and handed in here once the center tick drives a match); `c` is
 * the wide center Mat, read synchronously within this call (safe even for a
 * reused-buffer tap, same reasoning as `getFoveaTile`).
 */
export async function analyzeVergence(
  tiles: { l: Mat<Uint8Array>; r: Mat<Uint8Array> },
  c: Mat<Uint8Array>,
  opts: VergenceOptions,
): Promise<VergenceAnalysis> {
  const { l: tl, r: tr } = tiles;
  const {
    width,
    height,
    zoom: z,
    scale: s,
    target,
    expand_x = 3.0,
    expand_y = 2.0,
  } = opts;
  const W = (width / z) * expand_x; // Strip width
  const H = (height / z) * expand_y; // Strip height
  const ox = target.x - W / 2;
  const oy = target.y - H / 2;
  const tc = await getMatchTile(c, ox, oy, W, H, s);
  // Identical pipeline per eye: correlate the fovea tile into the wide strip,
  // smooth, then un-scale the peak back to full-resolution strip coordinates.
  const matchFovea = (tile: Mat<Uint8Array>) =>
    matchTemplate(tc, tile, "CCOEFF_NORMED").then((m) =>
      processMatch(gaussian(m, GAUSS_KSIZE, GAUSS_SIGMA), tile, 1 / s),
    );
  const [h1 = 0, w1 = 0] = tl.shape; // fovea tile size (scaled) — for `center.rect`
  const [guide, ml, mr] = await Promise.all([
    resize(tc, {}, 1 / s),
    matchFovea(tl),
    matchFovea(tr),
  ]);
  const center = {
    rect: RECT.fromCenter(VEC.sub(target, { x: ox, y: oy }), {
      width: w1 / s,
      height: h1 / s,
    }),
  };
  return { guide, ml, mr, center, ox, oy };
}

/**
 * Stage 2: constrained vergence step.
 *
 * The matched fovea centers and the target are lifted into center-camera angle
 * space, decomposed into {pan, verge, v_shift} errors, fed through the per-DOF
 * {@link PID} controllers (which integrate, dt-scale, and saturate), and the
 * resulting commands are turned back into both fovea voltages via
 * {@link inverseTriangulate} — guaranteeing the two foveas stay symmetric about
 * the gaze ray.
 *
 * Error decomposition (with `dL = aT - aL`, `dR = aT - aR`):
 *   pan     = (dL + dR) / 2          — common-mode mis-centering (calibration)
 *   verge   = aR.x - aL.x = 2b(1/Z - 1/z)  — horizontal disparity ⇒ depth
 *   v_shift = (aR.y - aL.y) / 2      — residual vertical disparity
 *
 * The `v_shift` sign is opposite the common-vertical (`pan.y`) one: `v_shift`
 * drives the two foveas in *opposite* vertical directions
 * (`out.l.y = ray.y + v_shift`, `out.r.y = ray.y - v_shift`), so given a stable
 * common-vertical loop, nulling the differential disparity needs the negated
 * error — otherwise `v_shift` slowly winds away to its limit.
 *
 * The PID integration is incremental (velocity) form, so its effect scales with
 * the call rate; `dt` (a rate-normalized step supplied by the caller) keeps
 * convergence wall-clock consistent across the variable pipeline throughput.
 *
 * Returns `null` (hold) when either match is too weak to trust — the PIDs are
 * left untouched so a low-confidence frame neither integrates nor winds down.
 */
export function stepVergence(
  analysis: VergenceStepInput,
  pids: VergencePIDs,
  conv: Pick<CoordinateConversions, "P2A" | "A2V">,
  ctrl: VergenceControl,
  dt: number,
): { left: Point2d; right: Point2d } | null {
  const { ml, mr, center: mc, ox, oy } = analysis;
  if (
    !(ml.score >= ctrl.minScore) ||
    !(mr.score >= ctrl.minScore) // also rejects NaN scores from flat patches
  )
    return null;
  // Lift matched centers (strip coords) into center-camera angles.
  const toAngle = (rect: Rect) => {
    const p = RECT.getCenter(rect);
    return conv.P2A.C({ x: p.x + ox, y: p.y + oy });
  };
  const aL = toAngle(ml.rect);
  const aR = toAngle(mr.rect);
  const aT = toAngle(mc.rect); // == target ray
  // Constrained errors (see header).
  const dL = VEC.sub(aT, aL);
  const dR = VEC.sub(aT, aR);
  const ePan = VEC.mul(VEC.add(dL, dR), 0.5);
  const eVerge = aR.x - aL.x;
  const eVshift = (aR.y - aL.y) / 2;
  // Each PID integrates its error, dt-scales it, and saturates to a physical
  // range so a bad estimate can at worst rest at a limit — never fling a fovea.
  const shift = {
    x: pids.panX.step(ePan.x, dt),
    y: pids.panY.step(ePan.y, dt),
  };
  const verge = pids.verge.step(eVerge, dt);
  const v_shift = pids.v_shift.step(eVshift, dt);
  // Reconstruct both poses symmetrically about the (shift-corrected) ray.
  const ray = VEC.add(aT, shift);
  const distance = vergeToDistance(verge, ctrl.baseline);
  const A = inverseTriangulate(ray, ctrl.baseline, distance, v_shift);
  return { left: conv.A2V.L(A.l), right: conv.A2V.R(A.r) };
}
