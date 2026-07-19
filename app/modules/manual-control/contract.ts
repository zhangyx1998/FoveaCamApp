// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the manual-control session — a calibrated L/C/R triple
// steering the controller node with NO tracker; also owns capture + recording
// (the raw camera access lives here). Behavior spec: docs/spec/manual-control.md.

import { cmd, defineContract, type FramePayload } from "@lib/orchestrator/protocol";
import type { Point2d, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { captureCommands, captureTelemetry, type Stat } from "@lib/orchestrator/contracts";
import type { TriggerTelemetry } from "@lib/trigger-sync";

/** The center-tile view (spec §views). `sliced` rides the display worker's
 *  magnified `session.frame`; `disparity`/`anaglyph` bind the COMPOSITE pipe,
 *  `sgbm` the STEREO heatmap pipe (all native, renderer-bound via SHM). */
export type CenterView = "sliced" | "disparity" | "anaglyph" | "sgbm";

/** Coerce a persisted/legacy `view` value onto the current union: the retired
 *  display-kernel modes map onto their native successors (diff → the composite
 *  difference view, depth → the SGBM heatmap). Anything else falls back to
 *  `sliced`. Applied at the boundary wherever an untyped value can arrive. */
export function coerceView(view: unknown): CenterView {
  switch (view) {
    case "disparity":
    case "anaglyph":
    case "sgbm":
    case "sliced":
      return view;
    case "diff": // legacy kernel difference
      return "disparity";
    case "depth": // legacy depth-from-projection
      return "sgbm";
    default:
      return "sliced";
  }
}

/** Where to steer. Pixel mode needs server-side `undistort`; angle mode is
 *  radians the renderer computes locally, with optional distance/shift overrides. */
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
    /** Leased camera serials per role — raw center preview binds to the
     *  `camera:<serial>` pipe via `usePipeFrame`. Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
    /** The advertised `undistort:<serial>` pipe id while active —
     *  null when unadvertised (no calibration); renderer falls back to the raw
     *  `camera:<serial>` pipe. */
    undistortPipe: null as string | null,
    // Actuation parameters (renderer resolves and pushes concrete values).
    baseline: 200, // stereo baseline (mm)
    verge: 0, // verge slider (0 → ∞ distance)
    shift: 0, // vertical shift (deg)
    // Display parameters.
    zoom: 9, // fovea (sliced center) magnification
    /** Which center view the renderer SHOWS (spec §views) — `sliced` rides the
     *  display worker; the disparity/anaglyph/sgbm options bind native pipes
     *  (consumer-gated — selecting one connects its pipe, the rest park). */
    view: "sliced" as CenterView,
    /** Trigger-sync capture INTENT (spec §trigger-sync): the user asks for
     *  hardware-triggered L/R pairs on the MCU position stream; the intent
     *  latches and the session engages when preconditions permit (v2 controller
     *  + native stream + leased triple), surfacing `trigger_blocked` while it
     *  waits. No pairing/staleness here (manual-control has no match-join). */
    trigger_sync: false as boolean,
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
    // Per-eye projection of the commanded volts into wide-frame px ({0,0}
    // uncalibrated) — the fovea-footprint boxes, which separate while split.
    L_PX: { x: 0, y: 0 } as Point2d,
    R_PX: { x: 0, y: 0 } as Point2d,
    // Which eyes are steered independently (spec §split). Both false = unified.
    split: { l: false, r: false } as { l: boolean; r: boolean },
    // Control-path latency — `c.actuate()` round-trip, throttled like `volt`.
    perf: { actuateMs: { mean: 0, max: 0 } as Stat },
    /** Trigger-sync readout — non-null exactly while ENGAGED (spec
     *  §trigger-sync); published at the volt-telemetry throttle. */
    trigger: null as TriggerTelemetry | null,
    /** Human-readable reason trigger-sync engagement is WAITING (intent on,
     *  preconditions unmet, or the last engage attempt failed); null when
     *  engaged or when `trigger_sync` is off. */
    trigger_blocked: null as string | null,
    // Capture manifest telemetry (spec §capture); image data pulled via getPreview.
    ...captureTelemetry(),
    // Recording.
    recording_active: false as boolean,
    recordingStreams: {} as Record<
      string,
      { frames: number; dropped: number; fps: number; bytes: number }
    >,
  },
  // `center` (the magnified fovea crop) is the only session-frame view — it
  // backs `sliced`; disparity/anaglyph/sgbm bind native pipes instead. The
  // L/C/R main views bind their undistort pipes directly and capture previews
  // are PULLED via `getPreview` (spec §views, §capture).
  frames: ["center"] as const,
  commands: {
    /** Steer the target (pixel drag or a set-point's angle); any steer REUNIFIES
     *  the split (spec §targeting). */
    steer: cmd<SteerTarget>(),
    /** Pin ONE eye to a directly-chosen volt (a PosView drag), the other eye
     *  unified; cleared by any `steer` (spec §split). */
    splitEye: cmd<{ side: "l" | "r"; volt: Pos }>(),
    /** Resolve set-point angles to volts for the trace overlay — no state change. */
    previewVolts: cmd<VoltPreviewQuery[], VoltPair[]>(),
    /** Run ONE capture shot (spec §capture): snapshot metadata, stack the raw
     *  foveae + slice the center. AWAITABLE. `tag` present ⇒ a raster shot that
     *  accumulates an indexed resource; `tag === 0`/absent starts fresh. */
    capture: cmd<{ tag?: number }>(),
    /** Pull one held capture resource's data as 8-bit BGRA (spec §capture);
     *  `index` selects a raster entry. Legacy name; `getCapturePreview` aliases it. */
    getPreview: cmd<{ resource: string; index?: number }, FramePayload | null>(),
    // Shared capture mixin: `captureShot`/`getCapturePreview`/`saveCapture`/`discardCapture`.
    ...captureCommands(),
    /** Start writing raw L/C/R streams to disk at `path`. */
    startRecording: cmd<{ path: string }, boolean>(),
    /** Stop the active recording. */
    stopRecording: cmd(),
  },
});

export type ManualControlContract = typeof manualControl;
