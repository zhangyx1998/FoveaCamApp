// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Transport types for the shared DISPLAY vision kernel (C-22b step 2) —
// tracking-single / manual-control / multi-fovea's processed views, off the JS
// event loop. Fork-independent + worker-safe: numbers only.
//
// real-1g (C-23): the calibration (de)serialization that used to live here is
// GONE — the kernel's C input is the `undistort:<serial>` pipe (B's native
// remap producer), so no kernel reconstructs `Undistort` anymore. Everything
// the display path needs (fovea homographies, the depth Q-matrix, the slice
// center) main computes from calibration and ships as flat matrices/points.

import type { Point2d, Size } from "core/Geometry";

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

/** The display kernel's init params. `kind` selects this kernel in the worker. */
export type DisplayInit = { kind: "display" } & DisplayParams;
