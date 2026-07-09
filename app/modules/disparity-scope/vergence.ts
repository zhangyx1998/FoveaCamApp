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
import { distanceToVerge, inverseTriangulate, vergeToDistance } from "@lib/stereo";
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
  /** Nominal display zoom (the center-tile crop ratio, wide-px per fovea-px, as
   *  CONFIGURED in app-config). Defines the guide strip crop — the center tile
   *  (`width/zoom × height/zoom` at the target) expanded by `expand_x/expand_y`
   *  — and the center-tile marker, so the guide matches the sliced center view.
   *  This is NOT the template-match magnification: the fovea tiles are pre-sized
   *  to the (possibly calibration-measured) match scale by the caller via
   *  {@link foveaTileSize}, and the tile↔strip pixel-scale agreement is carried
   *  by `scale` independently of this crop size. */
  zoom: number;
  /** Scale of the fovea tiles (1.0 ~ zoom); higher = more detail, more compute. */
  scale: number;
  /** Target center within the wide frame (pixels). */
  target: Point2d;
  /** Expansion factor for the match strip. */
  expand_x: number;
  expand_y: number;
};

/** Fovea tile size for the template match. `zoom` here is the MATCH
 *  MAGNIFICATION (measured fovea↔wide ratio, else nominal) — NOT the display
 *  crop zoom of {@link VergenceOptions.zoom}: one fovea frame covers
 *  `width/zoom` wide pixels, and at strip downsample `scale` that footprint is
 *  `(width*scale)/zoom` tile pixels, so both the tile and the guide strip land
 *  at `scale` px per wide px (CCOEFF matching is not scale-invariant). Callers
 *  precompute tiles at this size via {@link getFoveaTile}. */
export function foveaTileSize(opts: {
  width: number;
  height: number;
  /** Match magnification (measured fovea↔wide ratio, else nominal zoom). */
  zoom: number;
  scale: number;
}): Size {
  const { width, height, zoom: z, scale: s } = opts;
  return { width: (width * s) / z, height: (height * s) / z };
}

// The fovea-footprint display math lives in the core-free `display-geometry.ts`
// (the RENDERER draws the pose markers with it and must not pull this module's
// runtime `core/Vision` imports); re-exported here so the vision/control side
// and the tests keep one import surface.
export { foveaFootprintOnWide } from "./display-geometry";

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

/** The minimal 2D controller shape {@link stepVergence} drives for the `pan`
 *  DOF — worker A's `PID2D` (@lib/pid) satisfies it structurally. Declared here
 *  (rather than importing `PID2D`) so the vergence math + its unit test stay
 *  independent of the 2D class: a `Point2d` error in, the saturated `Point2d`
 *  command out, plus the integrator value for telemetry/seed. */
export interface Vec2Controller {
  step(error: Point2d, dt?: number): Point2d;
  readonly value: Point2d;
}

/**
 * The named DOF controllers the vergence step integrates. Rather than
 * commanding the four fovea pixel DOF (L.x, L.y, R.x, R.y) independently —
 * which lets the foveas drift apart on noisy frames — the loop integrates
 * these physically-meaningful DOF and reconstructs both fovea poses
 * symmetrically about the gaze ray. Post-replumb these live inside the
 * disparity-scope PID node (`createPidNode`): `pan` is a `PID2D`, `verge` and
 * `v_shift` are scalar {@link PID}s (all with the same {@link PID} guarantees:
 * velocity-form integrator = command, anti-windup clamp, dt-scaling).
 */
export type VergenceControllers = {
  /** Common-mode ray correction, x/y (rad) — a 2D controller. */
  pan: Vec2Controller;
  /** Inverse-√depth verge parameter (0 ⇒ ∞, larger ⇒ nearer). */
  verge: PID;
  /** Vertical half-shift between the foveas (rad). */
  v_shift: PID;
};

/**
 * The scope's control OUTPUT (docs/proposals/pid-nodes-and-view-replumb.md
 * §"Disparity re-plumb"): the matched fovea centers + the target, projected
 * onto the UNDISTORTED wide frame in full-resolution wide pixels (the strip
 * offsets `ox`/`oy` are already folded in), plus the per-eye match confidence.
 * This is the only thing the control path (the PID node) consumes — the views
 * source independently from their undistort pipes, so the scope kernel no
 * longer bottlenecks view fps.
 */
export type ScopeProjection = {
  l: Point2d;
  r: Point2d;
  target: Point2d;
  scores: { l: number; r: number };
  /** True while the target rides a TRACKER OVERRIDE (a pointer drag pinning
   *  the chained KCF's output — controller-node-and-fifo-edges §3.5). The flag
   *  propagates downstream unchanged (tracker → matcher → here → the control
   *  step) so each stage acts correspondingly: the control step switches to
   *  DIRECT follow ({@link followTarget} — the foveas track the cursor ray 1:1
   *  at the held vergence, no PID stepping, no match-score gate) while the
   *  session holds its freeze window open and reports "manual" status. Data,
   *  not topology — it rides the projection record, no graph change. */
  overridden: boolean;
};

/**
 * Lift the analysis' strip-local match rects into the scope {@link
 * ScopeProjection}: each rect centre + the strip origin `(ox, oy)` is that
 * match's full-resolution wide-frame position — EXACTLY the point the
 * pre-replumb `stepVergence.toAngle` fed to `P2A` (`{x: cx + ox, y: cy + oy}`),
 * extracted here as the pure emission math so it is unit-testable without any
 * native Vision op. The kernel emits this alongside the diagnostic frames; the
 * control step consumes it.
 */
export function scopeProjection(
  a: VergenceStepInput,
  /** Tracker-override flag on the target that drove this match — carried
   *  through unchanged (see {@link ScopeProjection.overridden}). */
  overridden = false,
): ScopeProjection {
  const lift = (rect: Rect): Point2d => {
    const c = RECT.getCenter(rect);
    return { x: c.x + a.ox, y: c.y + a.oy };
  };
  return {
    l: lift(a.ml.rect),
    r: lift(a.mr.rect),
    target: lift(a.center.rect),
    scores: { l: a.ml.score, r: a.mr.score },
    overridden,
  };
}

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
  // The guide strip = the CENTER TILE (`width/z × height/z`, the SAME nominal
  // crop the sliced view shows) expanded by `expand_x` horizontally and
  // `expand_y` vertically, cut around the target. `z` is the display crop zoom,
  // NOT the match magnification — the fovea tiles come in pre-sized to the
  // match scale, so the strip crop size is free to track the displayed tile.
  const W = (width / z) * expand_x; // Strip width  = center-tile width  · expand_x
  const H = (height / z) * expand_y; // Strip height = center-tile height · expand_y
  const ox = target.x - W / 2;
  const oy = target.y - H / 2;
  const tc = await getMatchTile(c, ox, oy, W, H, s);
  // Identical pipeline per eye: correlate the fovea tile into the wide strip,
  // smooth, then un-scale the peak back to full-resolution strip coordinates.
  const matchFovea = (tile: Mat<Uint8Array>) =>
    matchTemplate(tc, tile, "CCOEFF_NORMED").then((m) =>
      processMatch(gaussian(m, GAUSS_KSIZE, GAUSS_SIGMA), tile, 1 / s),
    );
  const [guide, ml, mr] = await Promise.all([
    resize(tc, {}, 1 / s),
    matchFovea(tl),
    matchFovea(tr),
  ]);
  // Center-tile marker: the un-expanded center tile, centred in the strip.
  // Anchored to the crop zoom `z` (was the fovea tile's match-magnification
  // shape, which drifts from the displayed center tile on a calibrated rig).
  const center = {
    rect: RECT.fromCenter(VEC.sub(target, { x: ox, y: oy }), {
      width: width / z,
      height: height / z,
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
 * Returns `null` (hold) when either match is too weak to trust — the
 * controllers are left untouched so a low-confidence frame neither integrates
 * nor winds down.
 *
 * INPUT SPACE (post-replumb): the projected centres arrive as UNDISTORTED
 * wide-frame pixels (the scope reads the center camera's undistort pipe), so
 * they lift to angles via `P2A.C(px, false)` — treated as already-undistorted,
 * the linear pinhole map, not the raw-pixel default the pre-replumb kernel
 * used (`undistort=true`). The math
 * is otherwise byte-for-byte the old control law; it is packaged inside the PID
 * node's control fn (the caller runs it via `node.step`).
 */
export function stepVergence(
  projection: ScopeProjection,
  ctl: VergenceControllers,
  conv: Pick<CoordinateConversions, "P2A" | "A2V">,
  ctrl: VergenceControl,
  dt: number,
): { left: Point2d; right: Point2d } | null {
  if (
    !(projection.scores.l >= ctrl.minScore) ||
    !(projection.scores.r >= ctrl.minScore) // also rejects NaN scores
  )
    return null;
  // Undistorted wide pixel → center-camera angle (already strip-offset-folded).
  const toAngle = (p: Point2d) => conv.P2A.C(p, false);
  const aL = toAngle(projection.l);
  const aR = toAngle(projection.r);
  const aT = toAngle(projection.target); // == target ray
  // Constrained errors (see header).
  const dL = VEC.sub(aT, aL);
  const dR = VEC.sub(aT, aR);
  const ePan = VEC.mul(VEC.add(dL, dR), 0.5);
  const eVerge = aR.x - aL.x;
  const eVshift = (aR.y - aL.y) / 2;
  // Each controller integrates its error, dt-scales it, and saturates to a
  // physical range so a bad estimate can at worst rest at a limit — never fling
  // a fovea. `pan` is a 2D controller (separate x/y integrators).
  const shift = ctl.pan.step(ePan, dt);
  const verge = ctl.verge.step(eVerge, dt);
  const v_shift = ctl.v_shift.step(eVshift, dt);
  // Reconstruct both poses symmetrically about the (shift-corrected) ray.
  const ray = VEC.add(aT, shift);
  const distance = vergeToDistance(verge, ctrl.baseline);
  const A = inverseTriangulate(ray, ctrl.baseline, distance, v_shift);
  return { left: conv.A2V.L(A.l), right: conv.A2V.R(A.r) };
}

/** The controller state {@link seedVergence} reconstructs — one value per DOF
 *  {@link stepVergence} integrates. Seeding a released PID node with these makes
 *  the resumed command continuous (velocity-form integrator = command). */
export type VergenceSeed = { pan: Point2d; verge: number; v_shift: number };

/**
 * DIRECT target follow (the drag path, user ruling 2026-07-08): reconstruct
 * both fovea poses for `target` from the HELD controller values — the exact
 * forward map of {@link stepVergence}'s tail (`ray = aT + pan`, then
 * `inverseTriangulate` at the verge-implied distance) with NO PID stepping and
 * NO match-score gate. Dragging must move the foveas even where the template
 * match fails; the match-gated loop deadlocked there (the strip recenters on
 * the dragged target, the foveas' actual gaze leaves the strip, both scores
 * drop below `minScore`, control holds, the foveas never move). Vergence is
 * NOT adjusted: `held.verge`/`held.v_shift` pass through untouched, so both
 * eyes pan together to the cursor ray at the current depth. Because the
 * controllers are held (not reset), releasing the drag resumes {@link
 * stepVergence} from the same values + the same target ⇒ the first resumed
 * output equals the last follow output (velocity-form integrator = command) —
 * continuity without any seeding.
 */
export function followTarget(
  target: Point2d,
  held: VergenceSeed,
  conv: Pick<CoordinateConversions, "P2A" | "A2V">,
  baseline: number,
): { left: Point2d; right: Point2d } {
  const ray = VEC.add(conv.P2A.C(target, false), held.pan);
  const distance = vergeToDistance(held.verge, baseline);
  const A = inverseTriangulate(ray, baseline, distance, held.v_shift);
  return { left: conv.A2V.L(A.l), right: conv.A2V.R(A.r) };
}

/**
 * Reconstruct the `{ pan, verge, v_shift }` controller state whose forward
 * reconstruction (`inverseTriangulate` + `ray = aT + pan`, see
 * {@link stepVergence}) reproduces a pair of per-eye gaze ANGLES `gL`/`gR`
 * (center-camera rad) about the target ray `aT`. This is the exact algebraic
 * inverse of that forward map, so seeding a released PID node with it gives
 * output continuity — the "resume from the released pose, no jump" contract.
 *
 * SPACE CONTRACT — the drag-release seam (this was the release-jump bug):
 * the inputs here are ANGLES, not volts. The forward law commands VOLTS via
 * `A2V(reconstruct(...))`; recovering the angles from an override *volt* pair
 * by inverting through `V2A` is LOSSY — `A2V` and `V2A` are independently
 * fitted PER-EYE regressions, so `V2A.L∘A2V.L ≠ V2A.R∘A2V.R`. A *parallel*
 * drag (both eyes commanded to the SAME ray) round-trips back as two slightly
 * DIFFERENT angles, which this reconstruction reads as a genuine toe-in ⇒ a
 * FABRICATED `verge`/`v_shift` the drag never intended ⇒ the mirrors converge
 * to "another location" the instant control resumes. So a caller that KNOWS the
 * commanded ray (the disparity drag path) must pass it directly as
 * `gL = gR = ray`: `tanDiff` is then exactly 0, `verge`/`v_shift` come out 0,
 * and the forward `A2V(ray)` reproduces the pinned volts exactly. Only the
 * generic volts-only override path (a caller that pinned arbitrary per-eye
 * volts, which genuinely encode a vergence) round-trips through `V2A`.
 *
 * @param parallelEps `|tan gL.x − tan gR.x|` below this ⇒ treated as parallel
 *   (verge 0), guarding the `z = baseline/tanDiff` divide.
 */
export function seedVergence(
  gL: Point2d,
  gR: Point2d,
  aT: Point2d,
  baseline: number,
  parallelEps = 1e-9,
): VergenceSeed {
  const v_shift = (gL.y - gR.y) / 2;
  const rayY = (gL.y + gR.y) / 2;
  const tanDiff = Math.tan(gL.x) - Math.tan(gR.x);
  let rayX: number;
  let verge: number;
  if (Math.abs(tanDiff) < parallelEps) {
    rayX = (gL.x + gR.x) / 2;
    verge = 0;
  } else {
    const z = baseline / tanDiff;
    rayX = Math.atan2((z * (Math.tan(gL.x) + Math.tan(gR.x))) / 2, z);
    verge = distanceToVerge(z, baseline);
  }
  return { pan: { x: rayX - aT.x, y: rayY - aT.y }, verge, v_shift };
}
