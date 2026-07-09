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
import type { Stat } from "@lib/orchestrator/contracts";
import {
  pidOverrideCmd,
  pidOverrideState,
} from "@lib/orchestrator/pid-override-contract";

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
  sensitivity: 1.0,
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
    // Physical stereo baseline (mm) — same field/default as manual-control
    // (docs/history/refactor/orchestrator.md §7.1 S1a); the old
    // renderer-only `useAppConfig().baseline_distance_mm` isn't reachable
    // from the orchestrator, and those two modules already established the
    // simpler per-module-state precedent instead of a shared app config.
    baseline: 200,
    /** Nominal FOV(wide) / FOV(fovea). Drives the sliced-view crop size, and
     *  is the template-match magnification FALLBACK only — when the extrinsic
     *  calibration carries a measured magnification, the match uses that
     *  instead (telemetry `match_magnification`); this knob then no longer
     *  influences matching. See docs/applications/disparity-scope.md. */
    zoom: 9.0,
    /** Which center composite the renderer SHOWS (renderer-local since the
     *  node split: "sliced" = the scope-tile slice pipe, "disparity"/
     *  "anaglyph" = DiffView composites of the L/R fovea pipes, "sgbm" = the
     *  stereo brick's heatmap pipe. Selecting a pipe-backed view is what
     *  CONNECTS its pipe — unselected views' producers park (no subscriber →
     *  no compute, stereo-disparity-and-heatmap-nodes ruling 2); kept in
     *  contract state so the choice survives window reloads). */
    view: "sliced" as "sliced" | "disparity" | "anaglyph" | "sgbm",
    tuning: DEFAULT_TUNING,
    tracker_enabled: false as boolean,
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
    /** Calibration-MEASURED fovea↔wide magnification driving the template
     *  match (mean of the per-eye `foveaWideMagnification` values), or null
     *  when unmeasured — the match then falls back to the nominal
     *  `state.zoom` and the UI presents the zoom knob as the active match
     *  scale. Set on activate; constant per activation. */
    match_magnification: null as number | null,
    tracker_bbox: null as Rect | null,
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
  },
  // Only the per-side correlation HEATMAPS remain session frames (split-
  // disparity-nodes, 2026-07-09): the sliced center view and the guide strip
  // ARE the session's slice pipes now (`camera/<serialC>/undistort/slice/
  // scope-tile` / `scope-strip`, renderer binds via `usePipeFrame`), the
  // L-vs-R disparity view is a renderer canvas composite (DiffView) of the
  // two fovea undistort pipes, and the L/C/R views source their own undistort
  // pipes as before. The heatmaps' `{rect, score}` rides telemetry as
  // `MatchInfo`, per this file's header comment.
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
  },
});

export type DisparityContract = typeof disparity;
