// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the calibrate-drift session (docs/history/refactor/
// orchestrator.md §7.1 S1b): measures and persists the small angular offset
// between "where the extrinsic regression predicts the wide camera should
// see the marker" and "where it actually appears," per fovea. Continuous
// live-tracking view, no wizard steps — three simultaneous marker trackers
// (`@orchestrator/marker-tracker`) plus a background visual-servo loop that
// keeps the mirrors pointed at the tracked markers so an operator can watch
// convergence. The renderer also reads the `controller` session directly for
// `pos`/`dv` (same pattern the old renderer's `getController()` had) — this
// contract only owns the tracking/drift-specific state.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import {
  pidOverrideCmd,
  pidOverrideState,
} from "@lib/orchestrator/pid-override-contract";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { captureCommands, captureTelemetry, recordingCommands, recordingTelemetry } from "@lib/orchestrator/contracts";

/** Live per-camera detection overlay — a generic point list (the matched
 *  marker's 4 corners), same simplification as calibrate-intrinsic. */
export type DetectionView = { points: Point2d[] } | null;

export const calibrateDrift = defineContract({
  state: {
    targetId: { L: 1, C: 0, R: 2 },
    /** Per-eye PID-node OVERRIDE slots (reusable fragment,
     *  `@lib/orchestrator/pid-override-contract`): a drag on `PosView` pins that
     *  eye's servo output at the dragged pose (control law held reset); the
     *  renderer reads it back via `usePidOverride`. Two named instances because
     *  each eye is a separate PID node — `applyPidOverride` stays generic. */
    pidOverrideL: pidOverrideState<Pos>(),
    pidOverrideR: pidOverrideState<Pos>(),
    /** Leased camera serials per role (C-22) — the renderer binds raw previews
     *  to the `camera:<serial>` pipe via `usePipeFrame`. Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
    /** The leased triple's config store path (`["triples", <hash>]`), or []
     *  pre-lease — the renderer opens this doc reactively to read the per-triple
     *  `baseline_mm` for LIVE marker spacing (per-triplet-settings wave,
     *  `useTripleBaseline`). Set on acquire. */
    configPath: [] as string[],
  },
  telemetry: {
    ready: false as boolean,
    detection: { L: null, C: null, R: null } as Record<"L" | "C" | "R", DetectionView>,
    /** Wide-camera angle the center tracker currently sees (drives the
     *  drift derivation and the servo's origin), or null with no target. */
    center_angle: null as Point2d | null,
    /** Live-derived drift (what "Update Drift" would write), per fovea. */
    derived: { L: null, R: null } as Record<"L" | "R", Point2d | null>,
    /** Currently-saved drift (the triple config's `drift_l`/`drift_r`). */
    saved: { L: null, R: null } as Record<"L" | "R", Point2d | null>,
    // Recording (capture-recorder-everywhere ruling 2).
    ...captureTelemetry(),
    ...recordingTelemetry(),
  },
  // No session frames: the raw L/C/R previews bind the `camera:<serial>` pipe
  // via `usePipeFrame` (C-22 migration); marker overlays are drawn from the
  // `detection` telemetry, not frames.
  frames: [] as const,
  commands: {
    setTargetId: cmd<{ role: "L" | "C" | "R"; id: number }>(),
    /** Per-eye override slot drivers (reusable `pidOverride` fragment): `{ value }`
     *  pins that eye's output (engage/update), `{ release: true }` resumes control
     *  (the servo node's `seed` keeps it continuous). Driven by `usePidOverride`. */
    pidOverrideL: pidOverrideCmd<Pos>(),
    pidOverrideR: pidOverrideCmd<Pos>(),
    /** Commit the live-derived drift to the triple's persisted config. */
    updateDrift: cmd<{ role: "L" | "R" | "ALL" }>(),
    /** Clear a fovea's saved drift. */
    clearDrift: cmd<{ role: "L" | "R" | "ALL" }>(),
    // Recording (capture-recorder-everywhere ruling 2): records the raw L/C/R
    // sensor streams (advert-verbatim, the OBVIOUS default set).
    ...captureCommands(),
    ...recordingCommands(),
  },
});

export type CalibrateDriftContract = typeof calibrateDrift;
