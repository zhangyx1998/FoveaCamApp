// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the manual-control session. Same substrate as
// tracking-single (calibrated L/C/R triple + actuation loop, both
// frame/timer-driven off the renderer's UI loop) minus the KCF tracker state
// machine — the target here is always whatever the renderer last steered to,
// either a mouse-drag pixel or a locally-held "set-point" (pure client-side
// data, no camera access — see `steer`'s tagged union). Also owns capture
// (stack/wrap/diff raw frames server-side, preview to the renderer, save on
// confirm) and recording (write raw L/C/R streams to disk), since neither can
// run without the raw camera access this session already holds — see
// docs/refactor/orchestrator.md roadmap items 5/6.

import { cmd, defineContract, type Serializable } from "@lib/orchestrator/protocol";
import type { Point2d, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import type { Stat } from "@lib/orchestrator/contracts";

/** Where to steer the target. Pixel mode needs server-side `undistort` (the
 *  renderer no longer holds calibration); angle mode is radians the renderer
 *  already computes locally from a selected set-point (pure client-side
 *  data), with optional per-point distance/shift overrides. */
export type SteerTarget =
  | { mode: "pixel"; value: Point2d }
  | {
      mode: "angle";
      value: Point2d;
      distance_mm?: number;
      shift_deg?: number;
    };

/** A batch of angle-mode targets to resolve to volts without steering (the
 *  set-points list preview trace) — same shape as `SteerTarget`'s angle
 *  variant minus the tag. */
export type VoltPreviewQuery = {
  value: Point2d;
  distance_mm?: number;
  shift_deg?: number;
};

export type VoltPair = { l: Pos; r: Pos };

export const manualControl = defineContract({
  state: {
    /** Leased camera serials per role (C-22) — raw center preview binds to the
     *  `camera:<serial>` pipe via `usePipeFrame`. Set on acquire. */
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
    wrap: true, // perspective-wrap L/R foveae into alignment
    view: "sliced" as "sliced" | "diff" | "depth", // `center` frame content
    depthWindowInv: 0, // depth-view near/far window (0 → ∞)
    // Capture parameters.
    cap_stack: 5, // frames averaged per capture
    // Remote (projector) display parameters — renderer-only concerns, but
    // authoritative here like everything else so multiple windows agree.
    remote_content: "NONE" as "NONE" | "L+R" | "checker",
    checker_corners: 10,
    checker_size_mm: 10,
  },
  telemetry: {
    ready: false as boolean, // calibrated triple leased + conversions loaded
    size: { width: 0, height: 0 } as Size, // center frame size (renderer clamps)
    target: { x: 0, y: 0 } as Point2d, // current steered target (center px)
    target_angle: { x: 0, y: 0 } as Point2d, // ...and in radians (angular)
    volt: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } } as { L: Pos; R: Pos },
    // Control-path latency (perf substrate, docs/refactor/orchestrator.md
    // §7.3 item 2) — `c.actuate()` round-trip, published at the same
    // throttle as `volt`.
    perf: { actuateMs: { mean: 0, max: 0 } as Stat },
    // Capture: per-resource metadata (name -> meta object, or array of them
    // for an indexed/multi-set-point capture), populated progressively as
    // each resource resolves. Image data arrives separately as frames on
    // dynamic `capture:<name>` (or `capture:<name>#<i>`) channels.
    captureBusy: false as boolean,
    capture_meta: {} as Record<string, Serializable>,
    // Recording.
    recording_active: false as boolean,
    recordingStreams: {} as Record<
      string,
      { frames: number; dropped: number; fps: number; bytes: number }
    >,
  },
  // L/C/R are the processed previews (C undistorted, L/R perspective-wrapped);
  // `center` is the magnified fovea crop around the target (sliced/diff/depth).
  // `capture:<name>` channels are dynamic, opened per capture resource.
  frames: ["L", "C", "R", "center"] as const,
  commands: {
    /** Steer the target (pixel drag or a selected set-point's angle). */
    steer: cmd<SteerTarget>(),
    /** Resolve a batch of set-point angles to volts, for the trace overlay —
     *  does not steer or change any state. */
    previewVolts: cmd<VoltPreviewQuery[], VoltPair[]>(),
    /** Capture wide/fovea/center/diff resources (optionally once per entry
     *  in `setpoints`, matching manual-control's per-set-point capture
     *  loop) into server-held pending state; previews stream as frames. */
    runCapture: cmd<{ setpoints: VoltPreviewQuery[] }>(),
    /** Persist the pending capture to disk and clear it. */
    saveCapture: cmd<{ path: string; format: string }>(),
    /** Discard the pending capture without saving. */
    discardCapture: cmd(),
    /** Start writing raw L/C/R streams to disk at `path`. */
    startRecording: cmd<{ path: string }, boolean>(),
    /** Stop the active recording. */
    stopRecording: cmd(),
  },
});

export type ManualControlContract = typeof manualControl;
