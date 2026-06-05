// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { Point2d } from "core/Geometry";
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
  const p = (L.c.x - R.c.x) * b;
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

/** Convert a verge (inverse-√depth) parameter to a metric distance. */
export function vergeToDistance(verge: number, baseline: number) {
  return verge > 0 ? baseline / (verge * verge) : Infinity;
}

/** Inverse of {@link vergeToDistance}: metric distance → verge parameter. */
export function distanceToVerge(distance: number, baseline: number) {
  return distance > 0 && distance < Infinity
    ? Math.sqrt(baseline / distance)
    : 0;
}
