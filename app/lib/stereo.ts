// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { Point2d } from "core/Geometry";
import { makeMat } from "./mat";
import { type Undistort } from "core/Vision";
import { VEC } from "./util/geometry";
import { avg } from "./util/math";

export function deriveFoveaIntrinsics(
  /** Undistort data for center wide camera */
  U: Undistort,
  /** Angular position of current view (center point) */
  A: Point2d,
  zoom: number,
  sensor_size = U.sensor_size,
) {
  const f = VEC.mul(U.focal, zoom);
  // Optical center in pixel coordinates
  const oc = U.center;
  // Center of current view in pixel coordinates
  const vc = U.position([A])[0]!;
  // Delta distance between from view center to optical center,
  // in pixel coordinates (zoom factor applied).
  const delta = VEC.mul(VEC.sub(vc, oc), zoom);
  // Center of current view in pixels (zoomed)
  const c: Point2d = {
    x: sensor_size.width / 2 - delta.x,
    y: sensor_size.height / 2 - delta.y,
  };
  // Return key parameters for Q matrix
  return { f, c };
}

export type FoveaIntrinsics = ReturnType<typeof deriveFoveaIntrinsics>;

export function createQMatrix(
  L: FoveaIntrinsics,
  R: FoveaIntrinsics,
  baseline: number,
) {
  const cx = L.c.x;
  const cy = avg([L.c.y, R.c.y]);
  const f = avg([L.f.x, L.f.y, R.f.x, R.f.y]);
  const b = 1 / Math.abs(baseline);
  // Principal-point disparity offset.
  // reprojectImageTo3D computes W = b·d + p and Z = f/W. Physically, with the
  // left camera at the origin and the right at +B: uL = f·X/Z + cxL,
  // uR = f·(X−B)/Z + cxR, so d = uL − uR = f·B/Z + (cxL − cxR) and
  // Z = f·B / (d + (cxR − cxL)) — i.e. p·B must equal cxR − cxL
  // (OpenCV's Q[3][3] = −(cx1−cx2)/B, same thing with this row's b = +1/B).
  // The (R−L) sign keeps the fixation plane at POSITIVE depth: converged
  // foveae have cxL < cxR (deriveFoveaIntrinsics shifts each virtual center
  // AWAY from the toe-in), so p must be positive → Z(d=0) = f/p = +z_fix
  // (the opposite sign would put it at negative depth).
  // Unit-pinned in app/test/stereo-q.test.ts.
  const p = (R.c.x - L.c.x) * b;
  const Q = new Float64Array([
    ...[1, 0, 0, -cx],
    ...[0, 1, 0, -cy],
    ...[0, 0, 0, f],
    ...[0, 0, b, p],
  ]);
  return makeMat(Q, [4, 4]);
}

/**
 * Reconstruct the two fovea pointing angles from a single gaze ray, a verge
 * distance, and a vertical shift. The foveas are placed symmetrically about the
 * ray (toe-in by `±atan(b/z)`), so they can never drift independently.
 *
 * @param angle Gaze ray in center-camera angular coordinates (rad).
 * @param baseline Inter-fovea baseline (same units as `z`, e.g. mm).
 * @param z Verge distance along the ray; `Infinity` ⇒ parallel (no toe-in).
 * @param s Vertical half-shift between the foveas (rad); +s raises L, lowers R.
 */
export function inverseTriangulate(
  angle: Point2d,
  baseline: number,
  z = Infinity,
  s = 0,
): { l: Point2d; r: Point2d } {
  const out = { l: { ...angle }, r: { ...angle } };
  if (z < Infinity && z > 0) {
    const b = baseline / 2;
    const x = z * Math.tan(angle.x);
    out.l.x = Math.atan2(x + b, z);
    out.r.x = Math.atan2(x - b, z);
  }
  if (s !== 0) {
    out.l.y += s;
    out.r.y -= s;
  }
  return out;
}

/**
 * Commanded convergence distance from the verge (inverse-√depth) control
 * parameter. This is the distance the loop is *aiming* for.
 */
export function vergeToDistance(verge: number, baseline: number) {
  return verge > 0 ? baseline / (verge * verge) : Infinity;
}

/**
 * Realized convergence distance from the two foveas' actual horizontal pointing
 * angles (triangulation). This is the distance the mirrors are *currently* fixated
 * at, derived from feedback rather than the command.
 *
 * EXACT inverse of {@link inverseTriangulate}'s symmetric fixation model
 * (used instead of the small-angle `baseline/sin(vergence)` form, which
 * biases the display at near range): on the gaze axis,
 * `aL = atan(b/z)`, `aR = −atan(b/z)` with `b = baseline/2`, so
 * `vergence = 2·atan(b/z)` and `z = b/tan(vergence/2)` exactly (round-trip
 * unit-pinned in app/test/stereo-q.test.ts). Callers only pass the angle
 * DIFFERENCE, so off-axis gaze remains a (second-order) approximation — the
 * fully-exact per-angle algebra `z = B/(tan aL − tan aR)` lives in
 * disparity-scope's `seedVergence`, which has both angles.
 *
 * Returns `Infinity` when the gaze rays are parallel or diverging (no convergence
 * point in front of the cameras), and for absurd magnitudes as the angle → 0.
 *
 * @param vergence Horizontal toe-in angle `aL.x − aR.x` (rad).
 * @param baseline Inter-fovea baseline (returned distance shares its units).
 */
export function vergenceToDistance(vergence: number, baseline: number) {
  const d = baseline / 2 / Math.tan(vergence / 2);
  return d > 0 && d < 1e8 ? d : Infinity;
}

/** Inverse of {@link vergeToDistance}: metric distance → verge parameter. */
export function distanceToVerge(distance: number, baseline: number) {
  return distance > 0 && distance < Infinity
    ? Math.sqrt(baseline / distance)
    : 0;
}
