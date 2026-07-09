// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Auto-vergence: drive both fovea cameras to fixate the same physical point.
//
// PURE geometry + control math since the node split (docs/proposals/
// split-disparity-nodes.md, 2026-07-09) — the template-match MECHANISM lives
// in the generic worker kernel (@orchestrator/template-match-kernel) fed by
// slice/scale bricks; this module keeps what the SESSION and the PID node
// need:
//
//   - the sizing math the scale nodes are tuned with (`foveaTileSize`,
//     `matchMagnification`);
//   - stepVergence() — constrained control on {pan, verge, v_shift},
//     reconstructing both fovea poses symmetrically about the gaze ray;
//   - followTarget() — the drag path's direct parallel follow;
//   - seedVergence() — the generic pidOverride release seed.
//
// The loop feeds back on the image-matched position rather than the
// calibration-predicted one, so a constant extrinsic-calibration offset is
// absorbed by the loop instead of biasing convergence. Core-free (types
// only): the control law and its tests never load the native addon.

import type { Point2d, Size } from "core/Geometry";
import { VEC } from "@lib/util/geometry";
import { PID } from "@lib/pid";
import { distanceToVerge, inverseTriangulate, vergeToDistance } from "@lib/stereo";
import type { CoordinateConversions } from "@lib/coordinate-conversions";

/** Fovea tile size for the template match — since the node split this is the
 *  `dsize` the session tunes the NEEDLE SCALE nodes with. `zoom` here is the
 *  MATCH MAGNIFICATION (measured fovea↔wide ratio, else nominal) — NOT the
 *  display crop zoom.
 *
 *  The needle scaler's SOURCE is the RAW fovea CONVERT pipe — the full fovea
 *  FOV filling the frame at fovea-native resolution (NOT the homography-
 *  undistort pipe, which lands the fovea at wide density and would divide by
 *  the magnification a SECOND time → the 81× too-small-needle defect; the
 *  session's `needleSources` owns that choice). Resizing that whole frame to
 *  this size lands the fovea view at `scale` px per wide px — the single,
 *  correct ÷magnification (legacy `getFoveaTile` semantics).
 *
 *  `width`/`height` must be PAIRED with `zoom`'s units (the session's
 *  `needleGeometry` owns the pairing): a MEASURED magnification is a
 *  fovea-px-per-center-px ratio → pass the FOVEA SOURCE frame dims (the
 *  convert pipe's native dims); the nominal-zoom fallback is a pure FOV ratio
 *  → pass the CENTER dims (the legacy `W_c/z`). Either way `width/zoom` is the
 *  frame's footprint in WIDE (center) pixels of world; at strip scale `scale`
 *  that footprint is `(width*scale)/zoom` tile pixels, landing the tile at
 *  `scale` px per wide px — the SAME scale the strip's `{ratio: scale}` node
 *  produces (CCOEFF matching is not scale-invariant). Mismatched pairing
 *  injects an uncorrected foveaRes/centerRes factor. */
export function foveaTileSize(opts: {
  /** Frame width paired with `zoom` (fovea dims for measured, center for nominal). */
  width: number;
  /** Frame height, same pairing as `width`. */
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
 * The scope's control INPUT: the matched fovea centers + the target on the
 * UNDISTORTED wide frame in full-resolution wide pixels, plus the per-eye
 * match confidence. Since the node split the SESSION's join composes this
 * from the two template-match nodes' results (each side's `origin +
 * rectCenter / stripScale`) — the pure lift is three additions, done at the
 * join (session.ts `onMatch`).
 */
export type ScopeProjection = {
  l: Point2d;
  r: Point2d;
  target: Point2d;
  scores: { l: number; r: number };
  /** True while a pointer drag pins the target (SESSION-LOCAL since the node
   *  split — the join stamps `dragging` here; nothing rides the reusable
   *  nodes). The control step acts on it: DIRECT follow ({@link followTarget}
   *  — both eyes parallel on the cursor ray, vergence at infinity; no PID
   *  stepping, no match-score gate) while the session holds its freeze window
   *  open and reports "manual" status. */
  overridden: boolean;
};

export type VergenceControl = {
  /** Inter-fovea baseline (mm). */
  baseline: number;
  /** Minimum match score in [-1, 1] required to trust a correction. */
  minScore: number;
};

/**
 * Constrained vergence step.
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
 * both fovea poses for `target` from the given controller values — the exact
 * forward map of {@link stepVergence}'s tail (`ray = aT + pan`, then
 * `inverseTriangulate` at the verge-implied distance) with NO PID stepping and
 * NO match-score gate. Dragging must move the foveas even where the template
 * match fails; the match-gated loop deadlocked there (the strip recenters on
 * the dragged target, the foveas' actual gaze leaves the strip, both scores
 * drop below `minScore`, control holds, the foveas never move).
 *
 * The DRAG resets pan/verge/v_shift at pointer-down (session, user rulings
 * 2026-07-08/09) and passes the (now all-zero) controller state — both eyes
 * exactly ON the raw cursor ray: PARALLEL, vergence at INFINITY, no residual
 * corrections. Controllers == command throughout, so releasing the drag
 * resumes {@link stepVergence} from the same values + the same target ⇒ the
 * first resumed output equals the last follow output (velocity-form
 * integrator = command) — continuity without any seeding; every DOF then
 * re-converges from scratch. The function itself is generic over `held`
 * (the map is the control law's reconstruction for ANY controller state).
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
