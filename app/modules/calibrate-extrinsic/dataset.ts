// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure reshape of captured `ExtrinsicRecord`s into the per-fovea
// `ExtrinsicDataset` that `loadExtrinsic`/`fitExtrinsicRegression` consume —
// types-only so it is unit-testable without the runtime graph. Behavior spec:
// docs/spec/calibrate-extrinsic.md §capture-measurements.

import type { ExtrinsicDataset } from "@lib/camera-config";
import type { Point2d } from "core/Geometry";
import type { ExtrinsicRecord, FinStats } from "./contract";

/** Reshape captured records into the per-fovea dataset; `key` selects the eye.
 *  The measured-magnification inputs come off the center record (side_pts ruling
 *  3, center quad ruling 2 fallback, marker sizes) — all optional, degrading to
 *  "no measured magnification" when absent (spec §capture-measurements). */
export function createDataSet(
  records: ExtrinsicRecord[],
  key: "L" | "R",
): ExtrinsicDataset {
  return records.map((r) => ({
    img_points: r[key].img_pts,
    obj_points: r[key].obj_pts,
    voltage: r[key].voltage,
    angle: r.C.angle,
    wide_img_points: r.C.side_pts?.[key],
    wide_center_points: r.C.img_pts.slice(0, 4),
    marker: r.C.marker,
  }));
}

/** Minimum samples for a trustworthy fit — the SAME threshold
 *  `fitExtrinsicRegression` gates on (review #14: below this the SVD returns
 *  a silently-plausible minimum-norm solution). `finalize` hard-gates here. */
export const MIN_FIT_SAMPLES = 10;

/** Per-eye angle→volt predictor shape (the fitted `ExtrinsicConversions.A2V`). */
export type A2VPredict = { predict(angle: Point2d): Point2d };

/**
 * Per-record fit RESIDUALS (review #14, session-computable half): for every
 * captured record, predict each eye's voltage from the FITTED conversions at
 * the record's measured center angle and compare against the RECORDED voltage
 * — the volt-space distance each sample disagrees with the fit it produced.
 * Pure TS (injectable predictors) so vitest pins it without the native solve.
 */
export function computeFinStats(
  records: ExtrinsicRecord[],
  fitted: { L: A2VPredict | null; R: A2VPredict | null },
): FinStats {
  const residual = (
    predict: A2VPredict | null,
    angle: Point2d,
    measured: Point2d,
  ): number | null => {
    if (!predict) return null;
    const p = predict.predict(angle);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return Math.hypot(p.x - measured.x, p.y - measured.y);
  };
  const residuals = records.map((r) => ({
    L: residual(fitted.L, r.C.angle, r.L.voltage),
    R: residual(fitted.R, r.C.angle, r.R.voltage),
  }));
  const rms = (key: "L" | "R"): number | null => {
    const vals = residuals
      .map((r) => r[key])
      .filter((v): v is number => v !== null);
    if (vals.length === 0) return null;
    return Math.sqrt(vals.reduce((a, v) => a + v * v, 0) / vals.length);
  };
  return {
    samples: records.length,
    minSamples: MIN_FIT_SAMPLES,
    residuals,
    rmsL: rms("L"),
    rmsR: rms("R"),
  };
}
