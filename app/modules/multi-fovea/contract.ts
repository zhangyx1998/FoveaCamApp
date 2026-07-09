// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Multi-fovea tracking surface. Round 1 is a hardware-free skeleton: the
// orchestrator owns target/tracker/stream state, but real synced frame capture
// is explicitly gated until the Stage-F hardware bench clears.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { Point2d, Rect, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { captureCommands, captureTelemetry, type Stat } from "@lib/orchestrator/contracts";

export const MAX_MULTI_FOVEA_TARGETS = 8;

export type MultiFoveaTrackerParams = {
  width: number;
  height: number;
  padX: number;
  padY: number;
  lostTolerance: number;
};

export type MultiFoveaTargetConfig = {
  enabled: boolean;
  center: Point2d;
  tracker: MultiFoveaTrackerParams;
};

export type MultiFoveaTargetTelemetry = {
  index: number;
  enabled: boolean;
  active: boolean;
  bbox: Rect | null;
  angle: Point2d;
  volt: { L: Pos; R: Pos };
  streamId: number | null;
  streamHz: number;
  lastFinAgeMs: number | null;
  lostCount: number;
};

export type MultiFoveaCaptureResult =
  | { ok: true }
  | { ok: false; reason: string };

const trackerDefaults: MultiFoveaTrackerParams = {
  width: 64,
  height: 64,
  padX: 64,
  padY: 64,
  lostTolerance: 10,
};

export function defaultMultiFoveaTarget(index: number): MultiFoveaTargetConfig {
  return {
    enabled: index === 0,
    center: { x: 0, y: 0 },
    tracker: { ...trackerDefaults },
  };
}

export const multiFovea = defineContract({
  state: {
    /** Leased camera serials per role (C-22) — raw center preview binds to the
     *  `camera:<serial>` pipe via `usePipeFrame`. Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
    /** The advertised `undistort:<serial>` pipe id while active (C-23, real-1g) —
     *  null when unadvertised (no calibration); renderer falls back to the raw
     *  `camera:<serial>` pipe. */
    undistortPipe: null as string | null,
    targets: [0, 1, 2, 3].map(defaultMultiFoveaTarget) as MultiFoveaTargetConfig[],
    pulse_ns: 1000000,
    /** Per-stream RECORDING compression switches (multi-fovea-recording ruling
     *  9): a flagged stream routes through the zlib CompressStream brick and
     *  the recorder consumes the `/zlib` sibling pipe instead. Default all off
     *  — lossless zlib may not hold full-rate 12p on all three cameras
     *  (rig-gated). A session contract option, deliberately not UI polish. */
    record_compress: { left: false, center: false, right: false } as Record<
      "left" | "center" | "right",
      boolean
    >,
  },
  telemetry: {
    ready: false as boolean,
    v2Capable: false as boolean,
    captureRejected: "stage-f-hardware-gated" as string,
    size: { width: 0, height: 0 } as Size,
    targets: [] as MultiFoveaTargetTelemetry[],
    scheduler: { inFlight: 0, frames: 0, rejects: 0, timeouts: 0 },
    perf: { trackMs: { mean: 0, max: 0 } as Stat },
    // Capture (shared mixin, ruling 3) — the stacked L/R + center-slice capture,
    // distinct from `captureOnce` (the stage-f hardware-synchronized MEMS shot).
    ...captureTelemetry(),
    // Recording (same field names as manual-control so the renderer's
    // `Recording` facade + RecordButton work verbatim).
    recording_active: false as boolean,
    recordingStreams: {} as Record<
      string,
      { frames: number; dropped: number; fps: number; bytes: number }
    >,
  },
  // No session frames: the wide (C) view + the per-fovea processed crops all
  // bind native pipes via `usePipeFrame` (the old `session.frame` producers were
  // removed in the pipe migration — see index.vue).
  frames: [] as const,
  commands: {
    setTargetEnabled: cmd<{ index: number; enabled: boolean }>(),
    steerTarget: cmd<{ index: number; center: Point2d }>(),
    placeTarget: cmd<{ index: number; center: Point2d }>(),
    resetTargets: cmd(),
    captureOnce: cmd<void, MultiFoveaCaptureResult>(),
    // Shared capture mixin (ruling 3): `captureShot`/`getCapturePreview`/
    // `saveCapture`/`discardCapture` — the stacked L/R + center-slice capture.
    ...captureCommands(),
    /** Start a multi-fovea recording at `path` (multi-fovea-recording r2.1:
     *  raw12p streams + descriptor channels + wide singleton). */
    startRecording: cmd<{ path: string }, boolean>(),
    /** Stop the active recording (finalize → auto-open viewer). */
    stopRecording: cmd(),
  },
});

export type MultiFoveaContract = typeof multiFovea;
