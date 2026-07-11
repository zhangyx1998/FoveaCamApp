// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the disparity-scope session — the single source of truth
// shared by the renderer view and the orchestrator session. Only plain,
// serializable data crosses here: display Mats ride the `frames` transport
// (never telemetry), so a `MatchResult`'s heatmap stays a frame while its
// `{rect, score}` rides telemetry.

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
  /** Convergence window (ms); 0 = no timeout (iterate forever). */
  timeout: number;
};

// Physical saturation limits, shared by the session (PID construction) and
// the renderer (slider ranges — the PID objects themselves are server-side
// now, so the UI recomputes the same bounds instead of reading them off a
// live object like the original single-process implementation did).
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
    // Physical stereo baseline (mm) — RESOLVED SERVER-SIDE at activate now
    // (Ruling A, 2026-07-09 per-triplet-settings wave): the session reads the
    // leased triple's `baseline_mm`, falling back to the legacy app-level
    // `baseline_distance_mm`, else 200 (`@lib/calibration-data.resolveBaseline`),
    // and pushes it here. The renderer no longer seeds it from app config. This
    // 200 is only the pre-activate placeholder; the verge-limit slider reads it
    // back. Not live: a Settings edit applies on the next session start.
    baseline: 200,
    /** Nominal FOV(wide) / FOV(fovea). Drives the sliced-view crop size, and
     *  is the template-match magnification FALLBACK only — when the extrinsic
     *  calibration carries a measured magnification, the match uses that
     *  instead (telemetry `match_magnification`); this knob then no longer
     *  influences matching. See docs/applications/disparity-scope.md. */
    zoom: 9.0,
    /** Which center view the renderer SHOWS (every option is pipe-backed now:
     *  "sliced" = the scope-tile slice pipe, "disparity"/"anaglyph" = the
     *  `stereo/composite` brick's RGBA8 pipe (ONE pipe, mode retuned server-
     *  side from this field — composite-node-and-center-select-fix), "sgbm" =
     *  the stereo brick's heatmap pipe. Selecting a view is what CONNECTS its
     *  pipe — unselected views' producers park (no subscriber → no compute,
     *  stereo-disparity-and-heatmap-nodes ruling 2); the disparity↔anaglyph
     *  flip retunes the SAME connected composite pipe (no reconnect). Kept in
     *  contract state so the choice survives window reloads). */
    view: "sliced" as "sliced" | "disparity" | "anaglyph" | "sgbm",
    tuning: DEFAULT_TUNING,
    tracker_enabled: false as boolean,
    /** Which OBJECT-TRACKER engine the auto-follow node runs — hot-swappable
     *  mid-session (the drop-in replacement nodes, user request 2026-07-11):
     *  `"hybrid"` = chained NCC match + re-detect (default, robust on mono
     *  needles + recovery), `"kcf"` = chained GRAY-pinned KCF. Both share the
     *  `KcfTracker` surface, so the session releases one and spins the other on
     *  the SAME source pipe + graph node id (no restart, no graph churn). The
     *  drawer's "Tracker" SingleSelect drives this; session-local, not
     *  persisted. See tracker-swap.ts. */
    tracker_type: DEFAULT_TRACKER_TYPE as TrackerType,
    /** KCF template size (pixels) — the arm ROI of the session-owned CHAINED
     *  tracker thread (controller-node-and-fifo-edges §3.5). Applied on the
     *  next (re-)arm, not live: the kernel no longer runs any KCF. */
    kernel: { w: 64, h: 64 },
    /** PID-node OVERRIDE slot (reusable fragment,
     *  `@lib/orchestrator/pid-override-contract`): server-authoritative
     *  `{ engaged, value }`, driven ONLY by the generic `pidOverride` command
     *  now (a programmatic caller that already has volts — output pinned,
     *  control law held reset, seeded release). Since §3.5 the scope UI's
     *  pointer DRAGS no longer touch this slot: they ride the TRACKER's
     *  override, with the PID node RUNNING throughout (see telemetry
     *  `overridden`). Kept for the module-agnostic `usePidOverride` proxy. */
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
    /** Calibration-MEASURED fovea↔wide magnification (mean of the per-eye
     *  ruled marker-quad ratios), or null when unmeasured. RULED precedence
     *  (2026-07-09): an explicit `state.zoom > 0` is AUTHORITATIVE for the
     *  match; this measured value drives the match only in Auto (`zoom === 0`),
     *  falling back to 1 when also null. The UI reads it back to show the
     *  active Auto scale. Set on activate; constant per activation. */
    match_magnification: null as number | null,
    /** The leased triple's stored optical zoom override (>0), or null when
     *  none is set — the MIDDLE tier of the ruled match-magnification order
     *  (knob > override > measured > 1). The UI reads it to show "Auto N×
     *  (triple override)" and to keep the degenerate-1× warning honest. Set on
     *  activate; constant per activation. */
    zoom_override: null as number | null,
    tracker_bbox: null as Rect | null,
    /** The auto-follow gate hit the lost-latch (~10 consecutive misses) and
     *  released while the toggle stays on — the drawer Status reads "lost"
     *  instead of a stale "armed", and the convergence timeout resumes
     *  (frozen() keys on the REAL gate; UI/UX review 2026-07-11). Cleared on
     *  every (re-)arm. */
    tracker_lost: false as boolean,
    /** True while a pointer drag pins the target (the tracker's override is
     *  engaged; SESSION-LOCAL flag since the node split — nothing rides the
     *  reusable match nodes). Drives the UI's override badge (which does not
     *  read the PID slot). */
    overridden: false as boolean,
    /** Live PID integrator values (debug readout, matches the original
     *  renderer's "PID Debug" fieldset). */
    pids: { verge: 0, panX: 0, panY: 0, v_shift: 0 } as PidReadout,
    // Control-path latency (perf substrate, docs/history/refactor/orchestrator.md
    // §7.3 item 2), same shape/throttle as manual-control.
    perf: { actuateMs: { mean: 0, max: 0 } as Stat },
    // Recording (capture-recorder-everywhere ruling 2): the shared mixin shape
    // the renderer's `Recording` facade + title-bar RecordButton read.
    ...captureTelemetry(),
    ...recordingTelemetry(),
  },
  // Only the per-side correlation HEATMAPS remain session frames (split-
  // disparity-nodes, 2026-07-09): the sliced center view and the guide strip
  // ARE the session's slice pipes now (`camera/<serialC>/undistort/slice/
  // scope-tile` / `scope-strip`, renderer binds via `usePipeFrame`), the
  // L-vs-R difference AND anaglyph views are the `stereo/composite` brick's
  // pipe (composite-node-and-center-select-fix — no longer a renderer
  // composite), and the L/C/R views source their own undistort pipes as
  // before. The heatmaps' `{rect, score}` rides telemetry as `MatchInfo`,
  // per this file's header comment.
  frames: ["match_left", "match_right"] as const,
  commands: {
    /** Pointer interaction on the wide view, in wide-frame pixels. */
    pointer:
      cmd<{ p: Point2d; buttons: number; phase: "down" | "move" | "up" }>(),
    /** Restore all tuning params to {@link DEFAULT_TUNING}. */
    resetTuning: cmd(),
    /** Clear the PID integrators so the foveas re-converge fresh. */
    reset_vergence: cmd(),
    /** Manually nudge one PID's integrator (debug slider) — same effect as
     *  the original renderer's direct `pids.verge.value = x` mutation. Now
     *  routed to the PID node's controllers (`pan`/`verge`/`v_shift`). */
    setPid: cmd<{ dof: keyof PidReadout; value: number }>(),
    /** Engage/update/release the vergence PID node's output override (reusable
     *  fragment). `{ value }` pins the output at those volts (engage/update);
     *  `{ release: true }` resumes control (the node's `seed` keeps it
     *  continuous). PROGRAMMATIC path only since §3.5 — pointer drags ride the
     *  TRACKER override via `pointer` instead (PID keeps running, no pinning);
     *  this command remains the module-agnostic volts proxy (`usePidOverride`). */
    pidOverride: pidOverrideCmd<VergenceVolts>(),
    // Recording (capture-recorder-everywhere ruling 2): records the app's raw
    // L/C/R sensor streams (advert-verbatim; the OBVIOUS default set).
    ...captureCommands(),
    ...recordingCommands(),
  },
});

export type DisparityContract = typeof disparity;
