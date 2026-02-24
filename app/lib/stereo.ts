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
