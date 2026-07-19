// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Multi-fovea tracking surface — the typed boundary shared by renderer +
// orchestrator. Real synced frame capture requires hardware. Behavior spec:
// docs/spec/multi-fovea.md.

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

/** A fixed MIRROR-ANGLE preset location (deg, pan/tilt). Present → a STATIC
 *  angle-space fovea (no KCF); absent → image-space KCF target (spec §targets). */
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

/** Exposure-derived trigger budget (`pairTriggerBudget`): the pulse +
 *  pacing the session derived from the leased pair's CONFIGURED exposure —
 *  null until a triple is leased. */
export type TriggerBudgetTelemetry = {
  /** Trigger pulse width (µs, the wire unit — `FrameArg.pulse`). */
  pulseUs: number;
  maxRateHz: number;
  minIntervalMs: number;
  exposureUsL: number;
  exposureUsR: number;
  settleUs: number;
};

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

/** The demo's default PRESET LOCATIONS (deg): two interleaved foveas at ±5°. The
 *  seed the app opens with (see `demoPresetTarget`). */
export const DEFAULT_PRESET_LOCATIONS: PresetLocation[] = [
  { pan: -5, tilt: -5 },
  { pan: 5, tilt: 5 },
];

/** Conservative preset-angle bound (deg, symmetric) — the A2V DAC assert THROWS
 *  rather than clamps, so every preset entry point clamps here (spec §targets).
 *  Tune to the mirror's real safe deflection once confirmed on hardware. */
export const PRESET_ANGLE_LIMIT_DEG = 10;

/** Clamp one preset angle component into the safe symmetric range. */
export function clampPresetAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return Math.max(-PRESET_ANGLE_LIMIT_DEG, Math.min(PRESET_ANGLE_LIMIT_DEG, deg));
}

/** The demo default for slot `index`: the first `DEFAULT_PRESET_LOCATIONS` are
 *  enabled angle-space presets, the rest disabled plain targets (spec §targets). */
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
    /** Leased camera serials per role — raw center preview binds to the
     *  `camera:<serial>` pipe via `usePipeFrame`. Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
    /** The advertised `undistort:<serial>` pipe id while active —
     *  null when unadvertised (no calibration); renderer falls back to the raw
     *  `camera:<serial>` pipe. */
    undistortPipe: null as string | null,
    // Demo default: two interleaved angle-space presets at ±5° (spec §targets).
    targets: [0, 1, 2, 3].map(demoPresetTarget) as MultiFoveaTargetConfig[],
    /** CMD_FRAME trigger pulse width — DISPLAY/PERSIST unit is ns; the wire
     *  (`FrameArg.pulse`) is µs, so the session divides by 1000 at the frame
     *  boundary. While `pulse_auto` holds, the session derives it from the
     *  pair's configured exposure; a client write (the Pulse slider) flips
     *  `pulse_auto` off — manual override. */
    pulse_ns: 1000000,
    /** Derive `pulse_ns` from the leased pair's exposure config. Any client
     *  write to `pulse_ns` sets this false. */
    pulse_auto: true as boolean,
    /** Trigger SETTLE hold (µs) — pushed into every CMD_FRAME (spec §settle). */
    settle_time_us: 0,
    /** Per-stream RECORDING compression switches — per-stream ENABLES of the
     *  app-level `record_compression` method (spec §recording). Default all off. */
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
    /** Exposure-derived trigger budget — null until a triple is leased. */
    budget: null as TriggerBudgetTelemetry | null,
    perf: { trackMs: { mean: 0, max: 0 } as Stat },
    // Capture (shared mixin; spec §capture) — the degraded raw-stack shot.
    ...captureTelemetry(),
    // Recording (same field names as manual-control's facade + RecordButton).
    recording_active: false as boolean,
    recordingStreams: {} as Record<
      string,
      { frames: number; dropped: number; fps: number; bytes: number }
    >,
  },
  // No session frames: the wide (C) view + per-fovea crops all bind native
  // pipes via `usePipeFrame`.
  frames: [] as const,
  commands: {
    setTargetEnabled: cmd<{ index: number; enabled: boolean }>(),
    steerTarget: cmd<{ index: number; center: Point2d }>(),
    placeTarget: cmd<{ index: number; center: Point2d }>(),
    /** Set a target's fixed mirror-angle preset (deg) — a static preset, no KCF (spec §targets). */
    placePreset: cmd<{ index: number; pan: number; tilt: number }>(),
    resetTargets: cmd(),
    captureOnce: cmd<void, MultiFoveaCaptureResult>(),
    ...captureCommands(),
    /** Start a multi-fovea recording at `path` (spec §recording). */
    startRecording: cmd<{ path: string }, boolean>(),
    /** Stop the active recording (finalize → auto-open viewer). */
    stopRecording: cmd(),
  },
});

export type MultiFoveaContract = typeof multiFovea;
