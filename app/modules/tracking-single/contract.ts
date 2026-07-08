// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the single-target tracking session. The orchestrator owns
// the calibrated L/C/R triple, runs the KCF tracker on the center stream and the
// actuation loop (both frame/timer-driven off the renderer's UI loop), and
// publishes L/C/R preview frames plus tracker/voltage telemetry. The renderer is
// a thin client: it pushes the actuation/tracker parameters as state, steers or
// engages the tracker via commands, and renders the frames + overlays.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { Point2d, Rect, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import type { Stat } from "@lib/orchestrator/contracts";

export const tracking = defineContract({
  state: {
    /** Leased camera serials per role (C-22) — the raw center preview binds to
     *  the `camera:<serial>` pipe via `usePipeFrame`. Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
    /** The advertised `undistort:<serial>` pipe id while active (C-23, real-1g) —
     *  null when unadvertised (no calibration); renderer falls back to the raw
     *  `camera:<serial>` pipe. */
    undistortPipe: null as string | null,
    // Actuation parameters (renderer resolves and pushes concrete values).
    baseline: 200, // stereo baseline (mm)
    verge: 0, // verge slider (0 → ∞ distance)
    shift: 0, // vertical shift (deg)
    // Display parameters.
    zoom: 9, // fovea (sliced center) magnification
    view: "sliced" as "sliced" | "diff" | "depth", // `center` frame content
    depthWindowInv: 0, // depth-view near/far window (0 → ∞)
    // Tracker parameters (renderer resolves defaults; concrete pixels here).
    tracker_w: 64,
    tracker_h: 64,
    pad_x: 64,
    pad_y: 64,
    lost_tolerance: 10, // consecutive misses before giving up
    pred_buffer_max: 10, // kinematic prediction sample window
  },
  telemetry: {
    ready: false as boolean, // calibrated triple leased + conversions loaded
    active: false as boolean, // KCF tracker engaged
    size: { width: 0, height: 0 } as Size, // center frame size (renderer clamps)
    bbox: null as Rect | null, // current tracker box (center-frame px)
    target: { x: 0, y: 0 } as Point2d, // current (predicted) target (center px)
    volt: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } } as { L: Pos; R: Pos },
    // Control-path latency (perf substrate, docs/history/refactor/orchestrator.md
    // §7.3 item 2), published at the same throttle as `volt`. `trackMs`:
    // onView entry -> tracker update done. `actuateMs`: c.actuate() round
    // trip. `frameAgeAtActuate`: time since the frame that produced the
    // current target, measured when that target is actually written out.
    perf: {
      trackMs: { mean: 0, max: 0 } as Stat,
      actuateMs: { mean: 0, max: 0 } as Stat,
      frameAgeAtActuate: { mean: 0, max: 0 } as Stat,
    },
  },
  // 2a re-plumb: the L/C/R views now source their undistort pipes DIRECTLY
  // (usePipeFrame), so they are no longer session frames. `center` — the
  // magnified fovea crop, or the diff/depth composite — is the only genuinely
  // kernel-DERIVED frame the session still publishes.
  frames: ["center"] as const,
  commands: {
    /** Engage the KCF tracker centered at a center-frame pixel. */
    startTracker: cmd<Point2d>(),
    /** Disengage the tracker (mirrors hold at the last target). */
    releaseTracker: cmd(),
    /** Steer the target directly (user drag); disengages the tracker. */
    steer: cmd<Point2d>(),
  },
});

export type TrackingContract = typeof tracking;
