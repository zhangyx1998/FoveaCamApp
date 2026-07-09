// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the calibrate-intrinsic session (docs/history/refactor/
// orchestrator.md §7.1 S1b): per-camera intrinsic calibration (checkerboard
// or ArUco/AprilTag marker), moved off the renderer. Unlike the fixed-triple
// sessions (manual-control/disparity-scope), this session manages an arbitrary set of
// connected cameras (like manage-cameras) rather than one fixed leased
// triple — the renderer selects one at a time to calibrate.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import {
  captureCommands,
  captureTelemetry,
  recordingCommands,
  recordingTelemetry,
  type CameraInfo,
} from "@lib/orchestrator/contracts";
import type { Point2d } from "core/Geometry";

export type PatternSize = { width: number; height: number };

/** One connected camera's calibration status, for the picker list. */
export type CalibrationView = {
  info: CameraInfo;
  role?: string;
  /** ISO date of the last successful `calibrateCamera` solve, or null. */
  calibrated_at: string | null;
  /** Field of view (radians), if calibrated. */
  fov: { x: number; y: number } | null;
  /** Overall RMS re-projection error of the stored solve, or null (uncalibrated
   *  or a calibration persisted before the core exposed it). */
  rms: number | null;
};

/** A captured record's downscaled grayscale preview (proposal item 4): a small
 *  Mono8 image (~160 px wide) so the records list shows what's being removed.
 *  `id` is a stable per-capture key (survives sibling removal). */
export type RecordThumb = {
  id: number;
  width: number;
  height: number;
  /** Row-major Mono8 pixels; the renderer wraps it in a Mat for `FrameView`. */
  data: Uint8Array;
};

/** Live per-frame detection overlay — a generic point list (checkerboard
 *  corners, or every detected marker's corners flattened together). Losing
 *  the original's per-marker outline grouping is a deliberate simplification
 *  (§7.1 S1b) — a dot per point is enough to see "is it detecting." */
export type DetectionView = { points: Point2d[] };

export const calibrateIntrinsic = defineContract({
  state: {
    /** Camera currently open for live detection; null = picker list. */
    activeSerial: null as string | null,
    method: "CHECKER" as "CHECKER" | "MARKER",
    pattern_size: { width: 6, height: 6 } as PatternSize,
    dictionary: "4X4_50",
    /** Marker detector downscale (1 = full res); matches the original
     *  renderer's `1/scale.value` convention (the slider stores `scale`). */
    scale: 4,
  },
  telemetry: {
    views: {} as Record<string, CalibrationView>,
    /** Live sensor size of the active camera (clears records on change,
     *  same as the original per-sub-view renderer implementation). */
    size: { width: 0, height: 0 },
    detection: null as DetectionView | null,
    recordCount: 0,
    /** Per-record downscaled previews, parallel to `recordCount` (item 4). */
    records: [] as RecordThumb[],
    busy: false as boolean,
    /** RMS re-projection error of the most recent solve (item 5), or null. */
    lastRms: null as number | null,
    /** Detector throughput in Hz, republished ~1×/s while a camera is open
     *  (item 6) — surfaced in the StreamView footnote. */
    detectRate: 0,
    // Recording (capture-recorder-everywhere ruling 2): degenerate single-stream
    // capture of the selected camera's raw sensor stream.
    ...recordingTelemetry(),
    // Capture (capture-recorder-everywhere ruling 3, item 4): single-stream still
    // capture (burst-stacked full-depth) of the selected camera's raw sensor.
    ...captureTelemetry(),
  },
  // No session frames: the raw preview binds the active camera's
  // `camera:<serial>` pipe via `usePipeFrame` (real-1c); detection overlays ride
  // the `detection` telemetry.
  frames: [] as const,
  commands: {
    /** Enumerate connected cameras + their calibration status. */
    refresh: cmd(),
    /** Open a camera for live detection. */
    select: cmd<{ serial: string }>(),
    /** Close the active camera, discarding any uncommitted records. */
    deselect: cmd(),
    /** Freeze the current detection into a record. */
    capture: cmd(),
    removeRecord: cmd<{ index: number }>(),
    /** Run `calibrateCamera` over every record and persist the result. */
    calibrateNow: cmd(),
    /** Clear a camera's stored intrinsic calibration (no need to select it). */
    resetCalibration: cmd<{ serial: string }>(),
    // Recording (capture-recorder-everywhere ruling 2): the selected camera's
    // raw sensor stream (advert-verbatim, degenerate single-stream default).
    ...recordingCommands(),
    // Capture (capture-recorder-everywhere ruling 3, item 4): the single-stream
    // capture mixin (captureShot / getCapturePreview / saveCapture / discardCapture).
    // Distinct from the app-local `capture` command (calibration records) above.
    ...captureCommands(),
  },
});

export type CalibrateIntrinsicContract = typeof calibrateIntrinsic;
