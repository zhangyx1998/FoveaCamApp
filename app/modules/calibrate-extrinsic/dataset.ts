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
import type { ExtrinsicRecord } from "./contract";

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
