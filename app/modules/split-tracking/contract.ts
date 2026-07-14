// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the split-tracking session — TWO INDEPENDENT single-eye
// visual servos. The user drops one target on the LEFT fovea view and one on
// the RIGHT; a switchable object tracker (hybrid / kcf) follows each with a
// configurable tile, and each mirror INDEPENDENTLY steers to keep its target at
// the fovea frame CENTER. No stereo/vergence coupling — the two sides never
// touch each other's state. Views are capturable and recordable.
// Behavior spec: docs/spec/split-tracking.md. RIG-GATED: tracker + servo
// behavior is unverified on hardware until the owed stage-f rig pass.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { Point2d, Rect, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import {
  captureCommands,
  captureTelemetry,
  recordingCommands,
  recordingTelemetry,
  type Stat,
} from "@lib/orchestrator/contracts";
// Single source of truth for the shared eye/tile/gain shapes + the safe gain
// default — the pure tracking module (never redefine them here; the session
// and the renderer both import from the same place).
import { DEFAULT_GAINS, type Eye, type PidGains, type TileSize } from "./tracking";

// Re-export the shared shapes so the renderer imports one boundary.
export type { Eye, PidGains, TileSize } from "./tracking";

export const splitTracking = defineContract({
  state: {
    /** Leased camera serials per role (C-22) — the fovea views bind each eye's
     *  undistort-or-convert pipe via `usePipeFrame`. Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
    /** Advertised per-eye undistort pipe id, else null (convert fallback). The
     *  renderer binds `undistort[eye] ?? convert(serials[eye])`. Set on acquire. */
    undistort: { L: null, R: null } as Record<Eye, string | null>,
    /** Which object-tracker engine both eyes run — hot-swappable mid-session
     *  (disparity-scope idiom; drawer switch). Session-local, not persisted. */
    tracker_type: "hybrid" as "hybrid" | "kcf",
    /** Tracker template ROI + view annotation (drawer-configurable px). Applied
     *  on the next (re-)arm of each armed side. */
    tile: { w: 512, h: 512 } as TileSize,
    /** Shared per-eye visual-servo PID gains (drawer-tunable). Applied live to
     *  both eyes' servos. Default from the pure module so the two never drift. */
    gains: { ...DEFAULT_GAINS } as PidGains,
  },
  telemetry: {
    /** Triple leased + trackers/servos wired. */
    ready: false as boolean,
    /** Per-eye tracked frame size (px) — the renderer clamps overlays + reads
     *  the frame center the servo drives toward. */
    size: { L: { width: 0, height: 0 }, R: { width: 0, height: 0 } } as Record<Eye, Size>,
    /** Per-eye live tracker readout (center/bbox in fovea image px) for the
     *  overlays; null before the first result. RIG-GATED. */
    tracked: { L: null, R: null } as Record<
      Eye,
      { center: Point2d | null; bbox: Rect | null; found: boolean } | null
    >,
    /** Servo ENGAGED per eye (armed & not dragging & not lost). Transition-ish
     *  boolean the drawer status rows read. */
    tracking: { L: false, R: false } as Record<Eye, boolean>,
    /** Latest commanded per-eye mirror volt (the accumulated servo output). */
    volt: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } } as Record<Eye, Pos>,
    /** Non-null when actuation is blocked (e.g. "no controller connected") —
     *  the tray-warning idiom; the servos hold while set. */
    blocked: null as string | null,
    /** Control-path latency (same shape/throttle as manual-control). */
    perf: { actuateMs: { mean: 0, max: 0 } as Stat },
    // Recording + capture (capture-recorder-everywhere ruling 2).
    ...captureTelemetry(),
    ...recordingTelemetry(),
  },
  // No session frames: the L/C/R views bind the camera pipes via `usePipeFrame`;
  // tracker overlays ride telemetry.
  frames: [] as const,
  commands: {
    /** Drag END on a side's target selector: (re-)arm that eye's tracker at
     *  `center` (fovea image px) + reset the servo + resume tracking. */
    armTarget: cmd<{ eye: Eye; center: Point2d }, void>(),
    /** Drag START on a side's target selector: stop servoing that eye + hold
     *  its mirror (the tracker keeps running, its results ignored while paused). */
    pauseTracker: cmd<{ eye: Eye }, void>(),
    /** Hot-swap BOTH eyes' tracker engine (disparity-scope idiom). */
    setTrackerType: cmd<{ type: "hybrid" | "kcf" }, void>(),
    /** Resize the tracker template + view annotation; re-arms both armed sides. */
    setTile: cmd<TileSize, void>(),
    /** Retune both eyes' servo PID gains live. */
    setGains: cmd<PidGains, void>(),
    ...captureCommands(),
    ...recordingCommands(),
  },
});

export type SplitTrackingContract = typeof splitTracking;
