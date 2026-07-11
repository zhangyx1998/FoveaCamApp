// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure projection math for the extrinsic-calibration visualizer: for each datapoint it
// pairs the OBSERVED marker corners with the PROJECTED corners the pinhole solve expects;
// the gap is the reprojection residual the visualizer draws. Reuses findPinholeProjection's
// math via the core-free projection-geom module (runs in a renderer, no native code) — the
// same construction, stopped one step before the homography regression smooths across poses.
// spec: docs/spec/calibration.md#calibration-visualizer

import type { Point2d } from "core/Geometry";
import type { ExtrinsicDataset } from "./camera-config.js";
import {
  bilinearInterpolate,
  relativeToAbsolute,
  shoelaceArea,
  transformPoints,
} from "./projection-geom.js";

/** The protocol's nominal object→canonical marker distance (matches
 *  `findPinholeProjection`'s `transformPoints(obj, angle, 1000)`). */
const NOMINAL_DISTANCE = 1000;

export interface DatapointProjection {
  /** Observed corners (the fovea image points, as captured). */
  observed: Point2d[];
  /** Model-projected corners (pinhole solve target) for the SAME corners. */
  projected: Point2d[];
  /** The pose center (bilinear centroid of the observed outer quad). */
  center: Point2d;
  /** Per-corner residual magnitude (px) — observed↔projected distance. */
  residuals: number[];
}

export interface RecordProjection {
  /** The single fitted image scale (mean px-per-object-unit) the projection
   *  uses across every pose — the same mean `findPinholeProjection` fits. */
  scale: number;
  points: DatapointProjection[];
  /** Bounding box over all observed + projected points (viewBox source when a
   *  sensor size isn't known). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** RMS residual (px) across every corner of every pose — a headline quality
   *  number for the visualizer. */
  rms: number;
}

const EMPTY_BOUNDS = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

/**
 * Fit the single image scale across the dataset: the mean, over poses, of
 * `sqrt(area(observedOuterQuad) / area(projectedCanonicalQuad))`. This is the
 * `scale` in `findPinholeProjection`; recomputed here (pure, core-free area) so
 * the visualizer never needs the native solve. Degenerate poses (zero-area
 * quads) are skipped; an all-degenerate dataset falls back to scale 1.
 */
export function fitScale(dataset: ExtrinsicDataset): number {
  const scales: number[] = [];
  for (const d of dataset) {
    const obs = d.img_points.slice(0, 4);
    if (obs.length < 4) continue;
    const rel = transformPoints(d.obj_points, d.angle, NOMINAL_DISTANCE).slice(0, 4);
    const aObs = shoelaceArea(obs);
    const aRel = shoelaceArea(rel);
    if (aObs > 0 && aRel > 0) scales.push(Math.sqrt(aObs / aRel));
  }
  if (scales.length === 0) return 1;
  return scales.reduce((a, b) => a + b, 0) / scales.length;
}

/**
 * Project every datapoint of an extrinsic dataset: observed corners vs the
 * pinhole solve's projected corners, plus per-corner residuals and an overall
 * RMS. Pure + unit-tested against a synthetic identity-ish calibration (a
 * scaled + translated marker at zero angle projects exactly onto its observed
 * corners → zero residual).
 */
export function projectDataset(dataset: ExtrinsicDataset): RecordProjection {
  const scale = fitScale(dataset);
  const points: DatapointProjection[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sqSum = 0;
  let n = 0;

  const grow = (p: Point2d) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };

  for (const d of dataset) {
    const outer = d.img_points.slice(0, 4);
    if (outer.length < 4) continue;
    const center = bilinearInterpolate(outer, [{ x: 0, y: 0 }])[0]!;
    const relative = transformPoints(d.obj_points, d.angle, NOMINAL_DISTANCE);
    const projected = relativeToAbsolute(relative, center, scale);
    // Pair observed ↔ projected by index (both derive from obj_points order).
    const count = Math.min(d.img_points.length, projected.length);
    const observed = d.img_points.slice(0, count);
    const proj = projected.slice(0, count);
    const residuals: number[] = [];
    for (let i = 0; i < count; i++) {
      const o = observed[i]!;
      const p = proj[i]!;
      const r = Math.hypot(o.x - p.x, o.y - p.y);
      residuals.push(r);
      sqSum += r * r;
      n++;
      grow(o);
      grow(p);
    }
    points.push({ observed, projected: proj, center, residuals });
  }

  return {
    scale,
    points,
    bounds: n === 0 ? { ...EMPTY_BOUNDS } : { minX, minY, maxX, maxY },
    rms: n === 0 ? 0 : Math.sqrt(sqSum / n),
  };
}

/**
 * The SVG viewBox for a record projection. Prefers the camera's `sensorSize`
 * (renders at the true camera aspect ratio, origin at 0,0); otherwise fits the
 * point bounding box with a small margin (aspect then follows the data). Shared
 * by the standalone visualizer and the live overlay so both frame identically.
 */
export function viewBoxFor(
  proj: RecordProjection,
  sensorSize?: { width: number; height: number } | null,
): { x: number; y: number; width: number; height: number } {
  if (sensorSize && sensorSize.width > 0 && sensorSize.height > 0)
    return { x: 0, y: 0, width: sensorSize.width, height: sensorSize.height };
  const { minX, minY, maxX, maxY } = proj.bounds;
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const mx = w * 0.08;
  const my = h * 0.08;
  return { x: minX - mx, y: minY - my, width: w + 2 * mx, height: h + 2 * my };
}
