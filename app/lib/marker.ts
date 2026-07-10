// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import {
  Projector,
  type MarkerDetectResult,
  findHomography,
  Mat,
} from "core/Vision";
import { area, type Point2d } from "core/Geometry";
import type { ExtrinsicDataset } from "./camera-config.js";
import { fitMagnification } from "./coordinate-conversions.js";
import Regression, { RegressionConfig } from "core/Regression";
// Pure marker-projection geometry lives in `projection-geom.ts` (core-free, so
// the renderer's calibration visualizer can share it). Re-exported here so the
// existing core-importing consumers (calibrate-* sessions) keep their import.
import {
  CORNER_OBJ_POINTS,
  bilinearInterpolate,
  relativeToAbsolute,
  transformPoints,
} from "./projection-geom.js";

export {
  CORNER_OBJ_POINTS,
  bilinearInterpolate,
  getInternalObjectPoints,
  isCorner,
  relativeToAbsolute,
  transformPoints,
} from "./projection-geom.js";

export function getMarkerProjection(result: MarkerDetectResult) {
  return Projector.solve(result, CORNER_OBJ_POINTS);
}

/**
 * Fit the angle→homography regression for one fovea from its extrinsic dataset.
 *
 * Also returns the MEASURED fovea↔wide optical `magnification` (with per-record
 * spread `magnification_std`): the distance-and-size-free ratio of the two
 * cameras' views of the marker — preferred from the wide camera's view of the
 * SAME side marker, else the center-marker fallback with marker-size metadata
 * (RULED 2026-07-09; see `fitMagnification`/`recordMagnification` in
 * @lib/coordinate-conversions). `null` when no record carries the wide quad
 * (legacy dataset) → the template-match consumer falls back to nominal zoom.
 *
 * The legacy `scale` (fovea px per object-unit at the protocol's nominal
 * 1000-unit distance) is still returned for continuity/diagnostics but NO
 * LONGER feeds the magnification — the old `scale·1000/focal` derivation was
 * retired (its 1000-side-length distance assumption is false on the rig).
 */
export async function findPinholeProjection(ds: ExtrinsicDataset) {
  const relative = ds.map(({ obj_points, angle }) =>
    transformPoints(obj_points, angle, 1000),
  );
  const scales = relative.map((r, i) =>
    Math.sqrt(area(ds[i]!.img_points.slice(0, 4)) / area(r.slice(0, 4))),
  );
  // Report mean and std of scales as zoom factor and its uncertainty
  const scale = scales.reduce((a, b) => a + b, 0) / scales.length || 1;
  const scale_std = Math.sqrt(
    scales.reduce((a, b) => a + (b - scale) ** 2, 0) / scales.length,
  );
  // Ruled magnification: same-side-marker ratio (else center-marker fallback).
  const { magnification, magnification_std } = fitMagnification(ds, area);
  console.log({ scale, scale_std, magnification, magnification_std });
  // Ger homography projection matrix H per angle
  const H = await Promise.all(
    relative.map((r, i) => {
      // Map relative pts back to image coordinates
      const img_pts = ds[i]!.img_points;
      const center = bilinearInterpolate(img_pts.slice(0, 4), [
        { x: 0, y: 0 },
      ])[0]!;
      const projected = relativeToAbsolute(r, center, scale);
      // Derive homography matrix H that maps img_pts to projected
      return findHomography(img_pts, projected);
    }),
  );
  // Create regression model on every element of H
  const keys = Array.from({ length: 9 }, (_, i) =>
    i.toString(),
  ) as (keyof Mat<Float64Array>)[];
  const config: RegressionConfig = {
    ply: [2, 1, 0],
    log: [],
    exp: [],
  };
  const A2H = new Regression<Point2d, Mat<Float64Array>>(
    ["x", "y"],
    keys,
    config,
  );
  const A = ds.map(({ angle }) => angle);
  return { A2H: A2H.fit(A, H), scale, scale_std, magnification, magnification_std };
}
