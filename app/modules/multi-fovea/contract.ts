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

/** A fixed MIRROR-ANGLE preset location (degrees, pan/tilt). When present on a
 *  target, that target is a STATIC angle-space fovea — the mirror parks at this
 *  angle and NO KCF tracking runs (the demo interleaves fixed locations). null/
 *  absent = the normal image-space, KCF-followed target. */
export type PresetLocation = { pan: number; tilt: number };

export type MultiFoveaTargetConfig = {
  enabled: boolean;
  center: Point2d;
  tracker: MultiFoveaTrackerParams;
  /** Fixed mirror-angle preset (deg). Present → static angle-space target (no
   *  KCF); null/absent → image-space KCF target. */
  preset?: PresetLocation | null;
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
    preset: null,
  };
}

/** The demo's default PRESET LOCATIONS (mirror-angle space, degrees). Two
 *  interleaved foveas: loc 1 = (-5°, -5°), loc 2 = (+5°, +5°). Editable in the
 *  drawer; this is the seed the app opens with (see `demoPresetTarget`). */
export const DEFAULT_PRESET_LOCATIONS: PresetLocation[] = [
  { pan: -5, tilt: -5 },
  { pan: 5, tilt: 5 },
];

/** Conservative preset-angle bound (deg, symmetric). The A2V polynomial has no
 *  domain guard and the DAC assert THROWS rather than clamps, so unbounded UI
 *  input could over-drive the mirror or error the frame — every preset entry
 *  point clamps to this. RIG-TUNE: set to the mirror's real safe deflection
 *  (calibration sweep domain) once confirmed; ±10° = 2x the demo pair. */
export const PRESET_ANGLE_LIMIT_DEG = 10;

/** Clamp one preset angle component into the safe symmetric range. */
export function clampPresetAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return Math.max(-PRESET_ANGLE_LIMIT_DEG, Math.min(PRESET_ANGLE_LIMIT_DEG, deg));
}

/** The demo default for slot `index`: the first `DEFAULT_PRESET_LOCATIONS` are
 *  enabled angle-space presets (interleaved by the round-robin trigger); the
 *  rest are disabled plain targets. Opening the app needs NO manual setup —
 *  two foveas immediately alternate at the two fixed angles. */
export function demoPresetTarget(index: number): MultiFoveaTargetConfig {
  const preset = DEFAULT_PRESET_LOCATIONS[index] ?? null;
  return {
    enabled: preset !== null,
    center: { x: 0, y: 0 },
    tracker: { ...trackerDefaults },
    preset: preset ? { ...preset } : null,
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
    // Demo default (user directive): two interleaved angle-space presets at
    // ±5°. Round-robin trigger machinery interleaves them with no manual setup.
    targets: [0, 1, 2, 3].map(demoPresetTarget) as MultiFoveaTargetConfig[],
    pulse_ns: 1000000,
    /** Trigger SETTLE hold (µs, v2.0) — pushed into every CMD_FRAME; the
     *  firmware holds the trigger this long after a stream SWITCH (mirror
     *  moved), THEN runs the normal exposure (independent of pulse). Seeded
     *  from the active triple's `settle_time_us` at activation; the drawer
     *  slider overrides it LIVE for the running session. 0 = no hold. */
    settle_time_us: 0,
    /** Per-stream RECORDING compression switches (multi-fovea-recording ruling
     *  9). As of the app-level `record_compression` setting (user directive
     *  2026-07-09) these are per-stream ENABLES of the CONFIGURED method — a
     *  flagged stream routes through the compression brick (zlib today) and the
     *  recorder consumes the `/zlib` sibling pipe INSTEAD; under method `"none"`
     *  the renderer disables the switches and NOTHING compresses (the gate also
     *  holds server-side at recording start). No longer hardwired to zlib.
     *  Default all off — lossless zlib may not hold full-rate 12p on all three
     *  cameras (rig-gated). */
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
    /** Set a target's fixed mirror-angle preset (deg, pan/tilt) — the demo's
     *  angle-space path. Marks the target a static preset (no KCF). */
    placePreset: cmd<{ index: number; pan: number; tilt: number }>(),
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
