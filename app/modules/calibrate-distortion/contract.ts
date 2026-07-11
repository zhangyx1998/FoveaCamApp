// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the calibrate-distortion session — despite the name this is
// a projector-alignment/homography validation tool (not lens distortion): it
// verifies a projected marker re-projects via a live-fit homography onto each
// fovea image. Continuous live view, no persistence.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { Point2d } from "core/Geometry";
import { captureCommands, captureTelemetry, recordingCommands, recordingTelemetry } from "@lib/orchestrator/contracts";

export type DetectionView = { points: Point2d[] } | null;
/** Live homography-warped preview + its target footprint — `H` is a flat
 *  row-major 3×3 (telemetry carries only serializable data; the warped image
 *  rides frames). */
export type ProjectionView = { H: number[]; points: Point2d[] } | null;

export const calibrateDistortion = defineContract({
  state: {
    targetId: { L: 1, C: 0, R: 2 },
    /** Leased camera serials per role; the preview binds `camera:<serial>` via usePipeFrame. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
    /** The triple's config path (`["triples", <hash>]`), [] pre-lease — the
     *  renderer opens it for the per-triple `baseline_mm` (live marker spacing). */
    configPath: [] as string[],
  },
  telemetry: {
    ready: false as boolean,
    detection: { L: null, C: null, R: null } as Record<"L" | "C" | "R", DetectionView>,
    projection: { L: null, R: null } as Record<"L" | "R", ProjectionView>,
    ...captureTelemetry(),
    ...recordingTelemetry(),
  },
  // Raw fovea previews ride `camera:<serial>` via usePipeFrame; only the warped
  // homography overlays remain session frames.
  frames: ["proj_L", "proj_R"] as const,
  commands: {
    setTargetId: cmd<{ role: "L" | "C" | "R"; id: number }>(),
    ...captureCommands(),
    ...recordingCommands(),
  },
});

export type CalibrateDistortionContract = typeof calibrateDistortion;
