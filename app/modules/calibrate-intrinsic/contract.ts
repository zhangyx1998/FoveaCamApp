// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the calibrate-intrinsic session — per-camera intrinsic
// calibration (checkerboard or marker), one camera selected at a time. Behavior
// spec: docs/spec/calibrate-intrinsic.md.

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

/** A captured record's downscaled Mono8 preview (~160 px) for the records list;
 *  `id` is a stable per-capture key (survives sibling removal). */
export type RecordThumb = {
  id: number;
  width: number;
  height: number;
  /** Row-major Mono8 pixels; the renderer wraps it in a Mat for `FrameView`. */
  data: Uint8Array;
};

/** Live per-frame detection overlay — a flat point list (checkerboard corners or
 *  every marker's corners flattened; a dot per point is enough to see detection). */
export type DetectionView = { points: Point2d[] };

export const calibrateIntrinsic = defineContract({
  state: {
    /** Camera currently open for live detection; null = picker list. */
    activeSerial: null as string | null,
    method: "CHECKER" as "CHECKER" | "MARKER",
    pattern_size: { width: 6, height: 6 } as PatternSize,
    dictionary: "4X4_50",
    /** Marker detector downscale (1 = full res; the slider stores `scale`). */
    scale: 4,
  },
  telemetry: {
    views: {} as Record<string, CalibrationView>,
    /** Live sensor size of the active camera (clears records on change). */
    size: { width: 0, height: 0 },
    detection: null as DetectionView | null,
    recordCount: 0,
    /** Per-record previews, parallel to `recordCount`. */
    records: [] as RecordThumb[],
    busy: false as boolean,
    /** RMS re-projection error of the most recent solve, or null. */
    lastRms: null as number | null,
    /** Detector throughput (Hz), republished ~1×/s — StreamView footnote. */
    detectRate: 0,
    ...recordingTelemetry(),
    ...captureTelemetry(),
  },
  // No session frames: the raw preview binds `camera:<serial>` via usePipeFrame;
  // detection overlays ride the `detection` telemetry.
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
    ...recordingCommands(),
    // Single-stream capture mixin — distinct from the app-local `capture` command
    // (calibration records) above.
    ...captureCommands(),
  },
});

export type CalibrateIntrinsicContract = typeof calibrateIntrinsic;
