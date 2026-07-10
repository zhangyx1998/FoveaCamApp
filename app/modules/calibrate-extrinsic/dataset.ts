// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure reshape of captured `ExtrinsicRecord`s into the per-fovea
// `ExtrinsicDataset` that `loadExtrinsic`/`fitExtrinsicRegression` consume.
// Extracted from `session.ts` so it is unit-testable without pulling the
// orchestrator's runtime graph (types only here). Carries the ruled
// measured-magnification fields (2026-07-09) through per eye, tolerating their
// absence on legacy scratch records.

import type { ExtrinsicDataset } from "@lib/camera-config";
import type { ExtrinsicRecord } from "./contract";

/** Reshape captured records into the per-fovea dataset shape
 *  `loadExtrinsic`/`fitExtrinsicRegression` consume. `key` selects the eye.
 *
 *  The measured-magnification inputs come off the CENTER record (`r.C`): the
 *  wide camera's view of THIS eye's side marker (`side_pts[key]`, ruling 3 —
 *  preferred), the wide camera's own center-marker quad (`img_pts.slice(0,4)`,
 *  ruling 2 fallback), and the marker sizes. All optional — a record captured
 *  before these fields existed (or where the wide camera couldn't see the side
 *  marker) simply omits them, and the fit degrades to "no measured
 *  magnification" for that record. */
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
