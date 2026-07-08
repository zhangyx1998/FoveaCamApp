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
    // Physical stereo baseline (mm) — same field/default as tracking-single
    // and manual-control (docs/history/refactor/orchestrator.md §7.1 S1a); the old
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
    /** Which composite the renderer wants for the `center.*` channel. */
    view: "sliced" as "sliced" | "disparity",
    /** Perspective-rectify each fovea onto its pointing pose before display. */
    wrap: true as boolean,
    tuning: DEFAULT_TUNING,
    tracker_enabled: false as boolean,
    /** KCF template size (pixels); also used as the search-window pad, same
     *  as the original renderer implementation. */
    kernel: { w: 64, h: 64 },
  },
  telemetry: {
    /** Calibrated triple leased + conversions loaded (§12.1-style pattern —
     *  see tracking-single/manual-control's own `ready`). */
    ready: false as boolean,
    status: "initializing" as string,
    /** Wide (center) frame size (renderer clamps overlays to it). */
    size: { width: 0, height: 0 },
    /** Actuator voltages read back from the mirrors. */
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
    /** Live PID integrator values (debug readout, matches the original
     *  renderer's "PID Debug" fieldset). */
    pids: { verge: 0, panX: 0, panY: 0, v_shift: 0 } as PidReadout,
    // Control-path latency (perf substrate, docs/history/refactor/orchestrator.md
    // §7.3 item 2), same shape/throttle as tracking-single/manual-control.
    perf: { actuateMs: { mean: 0, max: 0 } as Stat },
  },
  // L/C/R are the processed previews (L/R perspective-wrapped iff wrap,
  // C raw — this module never undistorts the wide view); `center.*` is the
  // magnified/combined fovea view; `guide`/`match_left`/`match_right` are the
  // template-match debug visualizations (heatmap Mats — their `{rect,score}`
  // rides telemetry as `MatchInfo`, per this file's header comment; the
  // written-back contract had dropped these two frame topics — added back
  // here, part of "revalidate before building on it").
  frames: [
    "L",
    "C",
    "R",
    "center.sliced",
    "center.disparity",
    "guide",
    "match_left",
    "match_right",
  ] as const,
  commands: {
    /** Pointer interaction on the wide view, in wide-frame pixels. */
    pointer:
      cmd<{ p: Point2d; buttons: number; phase: "down" | "move" | "up" }>(),
    /** Restore all tuning params to {@link DEFAULT_TUNING}. */
    resetTuning: cmd(),
    /** Clear the PID integrators so the foveas re-converge fresh. */
    reset_vergence: cmd(),
    /** Manually nudge one PID's integrator (debug slider) — same effect as
     *  the original renderer's direct `pids.verge.value = x` mutation. */
    setPid: cmd<{ dof: keyof PidReadout; value: number }>(),
  },
});

export type DisparityContract = typeof disparity;
