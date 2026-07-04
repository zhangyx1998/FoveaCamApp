// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Coordinate conversions for a calibrated fovea triple — angle ⇄ voltage (per
// fovea, drift-corrected), angle ⇄ wide pixel (intrinsic undistort), and
// angle → homography. Pure math over the loaded calibration objects, shared by
// the renderer and the orchestrator control loops.
//
// Inputs are described structurally (`ConversionInputs`) so both the renderer's
// `CalibratedTriple` (`camera.ts`) and the orchestrator's loaded triple
// (`orchestrator/calibration.ts`) satisfy it — neither side is coupled to the
// other's loader types.

import type { Point2d } from "core/Geometry";
import type { Undistort, Mat } from "core/Vision";
import { createMat } from "./mat.js";

/** Minimal regression shape the conversions need (predict only). */
type Predict<O> = { predict(x: Point2d): O };

/** Per-fovea extrinsic regressions. */
export type ExtrinsicConversions = {
  A2V: Predict<Point2d>;
  V2A: Predict<Point2d>;
  A2H: Predict<Mat<Float64Array>>;
};

/** Everything the conversions read from a calibrated triple. */
export interface ConversionInputs {
  LE: ExtrinsicConversions;
  RE: ExtrinsicConversions;
  CI: { undistort: Undistort | null };
  config: { drift_l?: Point2d; drift_r?: Point2d };
}

export function useCoordinateConversions({
  LE,
  CI,
  RE,
  config,
}: ConversionInputs) {
  /** Apply calibrated drift to target angular position */
  function applyDrift({ x, y }: Point2d, drift?: Partial<Point2d>): Point2d {
    return { x: x + (drift?.x ?? 0), y: y + (drift?.y ?? 0) };
  }
  /** Remove calibrated drift from angular position derived from voltage */
  function removeDrift({ x, y }: Point2d, drift?: Partial<Point2d>): Point2d {
    return { x: x - (drift?.x ?? 0), y: y - (drift?.y ?? 0) };
  }
  return {
    /** Conversion from angle (rad) to voltage (V) */
    A2V: {
      L(angle: Point2d) {
        return LE.A2V.predict(removeDrift(angle, config.drift_l));
      },
      R(angle: Point2d) {
        return RE.A2V.predict(removeDrift(angle, config.drift_r));
      },
    },
    /** Conversion from voltage (V) to angle (rad) */
    V2A: {
      L(volt: Point2d) {
        return applyDrift(LE.V2A.predict(volt), config.drift_l);
      },
      R(volt: Point2d) {
        return applyDrift(RE.V2A.predict(volt), config.drift_r);
      },
    },
    /** Conversion from angle (rad) to pixel (px) */
    A2P: {
      C(px: Point2d, distort = true) {
        if (!CI.undistort) throw new Error("Wide camera not calibrated");
        return CI.undistort.position([px], distort)[0];
      },
    },
    /** Conversion from pixel (px) to angle (rad) */
    P2A: {
      C(px: Point2d, undistort = true) {
        if (!CI.undistort) throw new Error("Wide camera not calibrated");
        return CI.undistort.angular([px], undistort)[0];
      },
    },
    /** Conversion from angle (rad) to homography matrix */
    A2H: {
      L(angle: Point2d) {
        const H = createMat(Float64Array, [3, 3]);
        return Object.assign(H, LE.A2H.predict(angle));
      },
      R(angle: Point2d) {
        const H = createMat(Float64Array, [3, 3]);
        return Object.assign(H, RE.A2H.predict(angle));
      },
    },
  };
}

export type CoordinateConversions = ReturnType<typeof useCoordinateConversions>;
