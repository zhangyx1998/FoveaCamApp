// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the disparity-scope session — the source of truth shared by
// the renderer and the orchestrator. Only serializable data crosses: display
// Mats ride the `frames` transport, their `{rect, score}` rides telemetry.
// Behavior spec: docs/spec/disparity-scope.md.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { Point2d, Rect } from "core/Geometry";
import { captureCommands, captureTelemetry, recordingCommands, recordingTelemetry, type Stat } from "@lib/orchestrator/contracts";
import {
  pidOverrideCmd,
  pidOverrideState,
} from "@lib/orchestrator/pid-override-contract";
import { DEFAULT_TRACKER_TYPE, type TrackerType } from "./tracker-swap";

/** The disparity-scope PID node's value type — per-eye mirror volts (the
 *  `{ l, r }` command pushed to the controller node). The override slot pins
 *  THIS. */
export type VergenceVolts = { l: Point2d; r: Point2d };

const ZERO: Point2d = { x: 0, y: 0 };

/** Matched fovea footprint + confidence, lifted into wide-frame pixels. */
export type MatchInfo = { rect: Rect; score: number };

/** kp / ki / kd, in order — one triple per PID group. */
export type Gains = [number, number, number];

/** All control tuning; persisted authoritatively by the orchestrator. */
export type Tuning = {
  pan: Gains;
  depth: Gains;
  v_shift: Gains;
  /** Control time-step per ms elapsed; higher = faster convergence. */
  sensitivity: number;
  /** Fovea-tile match scale in [0, 1] (0 = coarse/fast, 1 = full detail). */
  scale: number;
  /** Min CCOEFF score in [-1, 1] required to trust a correction. */
  min_score: number;
  /** Guide-strip expansion around the target tile. */
  expand_x: number;
  expand_y: number;
  /** Convergence window (ms); 0 = no timeout (iterate forever, slider max);
   *  -1 = auto-vergence DISABLED entirely (slider min — manual control only). */
  timeout: number;
};

// Physical saturation limits, shared by the session (PID construction) and the
// renderer (slider ranges — the PIDs are server-side, so the UI recomputes them).
export const VERGE_MIN_DISTANCE_MM = 150;
export const SHIFT_LIMIT_DEG = 5;
export const VSHIFT_LIMIT_DEG = 2;

export const DEFAULT_TUNING: Tuning = {
  pan: [0.02, 0.02, 0],
  depth: [1.0, 0.2, 0.5],
  v_shift: [0.02, 0.02, 0],
  sensitivity: 0.1,
  scale: 0,
  min_score: 0.1,
  expand_x: 3.0,
  expand_y: 2.0,
  timeout: 2000,
};

/** Current value of each constrained-DOF PID integrator — debug readout +
 *  the payload shape for `setPid`'s manual nudge. */
export type PidReadout = { verge: number; panX: number; panY: number; v_shift: number };

export const disparity = defineContract({
  state: {
    /** Leased camera serials per role (C-22) — raw center preview binds to the
     *  `camera:<serial>` pipe via `usePipeFrame`. Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
    /** Target center within the wide frame (pixels). */
    target: ZERO,
    /** Physical stereo baseline (mm), resolved SERVER-SIDE at activate (spec
     *  §magnification, Ruling A). 200 here is only the pre-activate placeholder
     *  the verge-limit slider reads back; not live. */
    baseline: 200,
    /** Nominal FOV(wide) / FOV(fovea) — drives the sliced-view crop, and is the
     *  match magnification FALLBACK only (spec §magnification). */
    zoom: 9.0,
    /** Which center view the renderer SHOWS — every option is pipe-backed;
     *  selecting a view CONNECTS its pipe (unselected producers park), the
     *  disparity↔anaglyph flip retunes the same composite pipe (spec §topology). */
    view: "sliced" as "sliced" | "disparity" | "anaglyph" | "sgbm",
    tuning: DEFAULT_TUNING,
    tracker_enabled: false as boolean,
    /** Which auto-follow tracker engine runs — hot-swappable mid-session (spec
     *  §tracker). Session-local, not persisted. See tracker-swap.ts. */
    tracker_type: DEFAULT_TRACKER_TYPE as TrackerType,
    /** Tracker template size (px) — the arm ROI; applied on the next (re-)arm. */
    kernel: { w: 64, h: 64 },
    /** PID-node OVERRIDE slot — server-authoritative `{engaged, value}`, driven
     *  ONLY by the generic `pidOverride` command (pointer drags ride the tracker
     *  override instead; spec §drag). Kept for the `usePidOverride` proxy. */
    pidOverride: pidOverrideState<VergenceVolts>(),
  },
  telemetry: {
    /** Calibrated triple leased + conversions loaded (§12.1-style pattern —
     *  see manual-control's own `ready`). */
    ready: false as boolean,
    status: "initializing" as string,
    /** Wide (center) frame size (renderer clamps overlays to it). */
    size: { width: 0, height: 0 },
    /** Predicted actuator voltages for the current command — the controller
     *  node's synchronous `update()` return (not a hardware readback; the v1
     *  `onApplied` readback feeds only the actuate-latency stat). */
    volt: { L: ZERO, R: ZERO } as { L: Point2d; R: Point2d },
    /** Horizontal toe-in angle (rad) from the realized poses. */
    vergence: 0,
    /** Distance the realized vergence triangulates to (m; Infinity = parallel). */
    realized_distance: 0,
    /** Distance the verge PID is aiming for (m). */
    commanded_distance: 0,
    /** Per-eye projection of the current pose into wide-frame pixels. */
    L_PX: ZERO,
    R_PX: ZERO,
    match_left: null as MatchInfo | null,
    match_right: null as MatchInfo | null,
    match_center: null as { rect: Rect } | null,
    /** Calibration-MEASURED fovea↔wide magnification, or null when unmeasured —
     *  drives the match only in Auto (spec §magnification). Constant per activation. */
    match_magnification: null as number | null,
    /** The leased triple's stored optical zoom override (>0), or null — the
     *  middle tier of the ruled order (spec §magnification). The UI shows "Auto
     *  N× (triple override)". Constant per activation. */
    zoom_override: null as number | null,
    tracker_bbox: null as Rect | null,
    /** The auto-follow gate hit the lost-latch and released while the toggle
     *  stays on — the drawer Status reads "lost" (spec §tracker). Cleared on (re-)arm. */
    tracker_lost: false as boolean,
    /** True while a pointer drag pins the target (session-local; spec §drag).
     *  Drives the UI override badge (not the PID slot). */
    overridden: false as boolean,
    /** Live PID integrator values (debug readout). */
    pids: { verge: 0, panX: 0, panY: 0, v_shift: 0 } as PidReadout,
    /** Control-path latency (same shape/throttle as manual-control). */
    perf: { actuateMs: { mean: 0, max: 0 } as Stat },
    ...captureTelemetry(),
    ...recordingTelemetry(),
  },
  // Only the per-side correlation HEATMAPS remain session frames; every other
  // view is a pipe now (spec §topology). Their `{rect, score}` rides telemetry.
  frames: ["match_left", "match_right"] as const,
  commands: {
    /** Pointer interaction on the wide view, in wide-frame pixels. */
    pointer:
      cmd<{ p: Point2d; buttons: number; phase: "down" | "move" | "up" }>(),
    /** Restore all tuning params to {@link DEFAULT_TUNING}. */
    resetTuning: cmd(),
    /** Clear the PID integrators so the foveas re-converge fresh. */
    reset_vergence: cmd(),
    /** Manually nudge one PID's integrator (debug slider). */
    setPid: cmd<{ dof: keyof PidReadout; value: number }>(),
    /** Engage/update/release the vergence PID node's output override. `{value}`
     *  pins the output; `{release:true}` resumes control (seeded continuous).
     *  Programmatic path only — pointer drags ride the tracker override (spec §drag). */
    pidOverride: pidOverrideCmd<VergenceVolts>(),
    ...captureCommands(),
    ...recordingCommands(),
  },
});

export type DisparityContract = typeof disparity;
