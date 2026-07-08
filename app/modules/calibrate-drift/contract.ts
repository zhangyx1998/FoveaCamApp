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
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";

/** Live per-camera detection overlay — a generic point list (the matched
 *  marker's 4 corners), same simplification as calibrate-intrinsic. */
export type DetectionView = { points: Point2d[] } | null;

export const calibrateDrift = defineContract({
  state: {
    targetId: { L: 1, C: 0, R: 2 },
    /** Manual mirror-position override (drag on `PosView`), takes priority
     *  over the tracker-driven servo command — same as the original. */
    override_left: null as Pos | null,
    override_right: null as Pos | null,
    /** Leased camera serials per role (C-22) — the renderer binds raw previews
     *  to the `camera:<serial>` pipe via `usePipeFrame`. Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
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
  },
  frames: ["L", "C", "R"] as const,
  commands: {
    setTargetId: cmd<{ role: "L" | "C" | "R"; id: number }>(),
    setOverride: cmd<{ role: "left" | "right"; pos: Pos | null }>(),
    /** Commit the live-derived drift to the triple's persisted config. */
    updateDrift: cmd<{ role: "L" | "R" | "ALL" }>(),
    /** Clear a fovea's saved drift. */
    clearDrift: cmd<{ role: "L" | "R" | "ALL" }>(),
  },
});

export type CalibrateDriftContract = typeof calibrateDrift;
