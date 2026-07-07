// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the calibrate-distortion session (docs/refactor/
// orchestrator.md §7.1 S1b) — despite the module name this is a projector-
// alignment/homography validation tool, not lens-distortion calibration: it
// visually verifies that a marker projected on a remote canvas re-projects
// via a live-fit homography back onto each fovea camera image. Continuous
// live view, no persistence — same shape as calibrate-drift minus the drift
// commit, plus two per-fovea homography/warp preview frames.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { Point2d } from "core/Geometry";

export type DetectionView = { points: Point2d[] } | null;
/** Live homography-warped preview + the marker footprint it targeted —
 *  `H` crosses as a flat row-major 3x3 (9 numbers), not a `Mat`, since
 *  telemetry only carries plain serializable data (frames carry the actual
 *  warped image separately). */
export type ProjectionView = { H: number[]; points: Point2d[] } | null;

export const calibrateDistortion = defineContract({
  state: {
    targetId: { L: 1, C: 0, R: 2 },
  },
  telemetry: {
    ready: false as boolean,
    detection: { L: null, C: null, R: null } as Record<"L" | "C" | "R", DetectionView>,
    projection: { L: null, R: null } as Record<"L" | "R", ProjectionView>,
  },
  frames: ["L", "C", "R", "proj_L", "proj_R"] as const,
  commands: {
    setTargetId: cmd<{ role: "L" | "C" | "R"; id: number }>(),
  },
});

export type CalibrateDistortionContract = typeof calibrateDistortion;
