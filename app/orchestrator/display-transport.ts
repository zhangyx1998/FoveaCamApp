// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Transport types + calibration (de)serialization for the shared DISPLAY vision
// kernel (C-22b step 2) — tracking-single + manual-control's processed views
// (undistorted center, wrapped foveae, sliced/diff/depth) moved off the JS event
// loop into the vision worker. Fork-independent + worker-safe: no core runtime,
// only `makeMat` + numbers.
//
// The worker reconstructs `new Undistort(cal)` for the center remap (the one
// op with no serializable-matrix shortcut). `CameraCalibration` carries
// `Mat<Float64Array>` fields — a TypedArray with tacked-on `shape`/`channels`
// that structuredClone DROPS — so `cal` can't cross the MessagePort as-is; it's
// flattened to plain arrays here and rebuilt in the worker. Everything else the
// display path needs (fovea homographies, the depth Q-matrix) main computes
// from calibration and ships as flat matrices per volt-update (like disparity).

import { makeMat } from "@lib/mat";
import type { CameraCalibration, Mat } from "core/Vision";
import type { Point2d, Size } from "core/Geometry";

/** A `Mat<Float64Array>` flattened for structured clone. */
export type SerializedMat = { data: number[]; shape: number[]; channels: number };

/** `CameraCalibration` with its Mats flattened (see header). */
export type SerializedCalibration = {
  date: number; // epoch ms (Date clones, but ms is transport-agnostic)
  sensor_size: Size;
  camera_matrix: SerializedMat;
  dist_coeffs: SerializedMat;
  rvecs: SerializedMat[];
  tvecs: SerializedMat[];
};

const serMat = (m: Mat<Float64Array>): SerializedMat => ({
  data: Array.from(m as unknown as Float64Array),
  shape: [...m.shape],
  channels: m.channels,
});

const deMat = (s: SerializedMat): Mat<Float64Array> =>
  makeMat(new Float64Array(s.data), s.shape, s.channels);

export function serializeCalibration(cal: CameraCalibration): SerializedCalibration {
  return {
    date: cal.date instanceof Date ? cal.date.getTime() : Date.now(),
    sensor_size: cal.sensor_size,
    camera_matrix: serMat(cal.camera_matrix),
    dist_coeffs: serMat(cal.dist_coeffs),
    rvecs: cal.rvecs.map(serMat),
    tvecs: cal.tvecs.map(serMat),
  };
}

export function deserializeCalibration(s: SerializedCalibration): CameraCalibration {
  return {
    date: new Date(s.date),
    sensor_size: s.sensor_size,
    camera_matrix: deMat(s.camera_matrix),
    dist_coeffs: deMat(s.dist_coeffs),
    rvecs: s.rvecs.map(deMat),
    tvecs: s.tvecs.map(deMat),
  };
}

/** Params main pushes to the display kernel (init + live, merged). All matrices
 *  are flat row-major; main recomputes homographies/Q on each throttled
 *  volt-update, sliceAt on target change. */
export type DisplayParams = {
  /** 9-element homography `A2H[role](V2A[role](volts))` per fovea (or null). */
  homographyL?: number[] | null;
  homographyR?: number[] | null;
  /** 16-element 4×4 depth reprojection Q-matrix (or null — no calibration). */
  qMatrix?: number[] | null;
  /** Undistorted center pixel to slice the magnified fovea around. */
  sliceAt?: Point2d;
  zoom?: number;
  /** "sliced" (magnified center crop) | "diff" | "depth" (combined fovea view). */
  view?: string;
  /** Show the perspective-wrapped fovea (vs the raw fovea) as the L/R preview. */
  wrap?: boolean;
  /** Depth heatmap clamp range (mm) for the "depth" combined view. */
  depthNear?: number;
  depthFar?: number;
};

/** Worker→main results: just the learned frame geometry (main needs it for the
 *  native tracker box clamp + capture size). Frames carry the pixels. */
export type DisplayValues = { size?: Size };

/** The display kernel's init params: the serialized calibration + initial
 *  display params. `kind` selects this kernel in the worker. */
export type DisplayInit = { kind: "display"; cal: SerializedCalibration | null } & DisplayParams;
