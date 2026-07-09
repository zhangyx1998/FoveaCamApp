// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the calibrate-extrinsic session (docs/history/refactor/
// orchestrator.md §7.1 S1b) — the largest/highest-risk migration in the
// roadmap: a 3-step wizard (CAL capture → FIN review/regression-fit → PRV
// interactive test) building the per-fovea extrinsic dataset (marker
// img/obj points + mirror voltage + wide-camera angle) that
// `orchestrator/calibration.ts`'s `loadExtrinsic`/`leaseCalibratedTriple`
// consume. `records` are plain serializable data (point arrays + voltages),
// so they ride telemetry directly — no per-record frame channels needed
// (the original's FIN/finalize screen doesn't even show live images, just
// SVG overlays from the recorded points).

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import {
  pidOverrideCmd,
  pidOverrideState,
} from "@lib/orchestrator/pid-override-contract";
import type { Point2d, Point3d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { recordingCommands, recordingTelemetry } from "@lib/orchestrator/contracts";

export type TrackerRecord = { img_pts: Point2d[]; obj_pts: Point3d[] };
export type ExtrinsicRecord = {
  L: TrackerRecord & { voltage: Point2d };
  C: TrackerRecord & { angle: Point2d };
  R: TrackerRecord & { voltage: Point2d };
};

export type DetectionView = { points: Point2d[] } | null;

export const calibrateExtrinsic = defineContract({
  state: {
    step: "CAL" as "CAL" | "FIN" | "PRV",
    targetId: { L: 1, C: 0, R: 2 },
    /** Per-eye PID-node OVERRIDE slots (reusable fragment,
     *  `@lib/orchestrator/pid-override-contract`): a CAL-step drag on `PosView`
     *  pins that eye's servo output at the dragged pose (control law held reset);
     *  the renderer reads it back via `usePidOverride`. Two named instances
     *  because each eye is a separate PID node — `applyPidOverride` stays generic. */
    pidOverrideL: pidOverrideState<Pos>(),
    pidOverrideR: pidOverrideState<Pos>(),
    /** Leased camera serials per role (C-22) — raw previews bind to the
     *  `camera:<serial>` pipe via `usePipeFrame`. Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
  },
  telemetry: {
    ready: false as boolean,
    detection: { L: null, C: null, R: null } as Record<"L" | "C" | "R", DetectionView>,
    records: [] as ExtrinsicRecord[],
    /** Both L/R regressions fit successfully (gates "Preview Results"). */
    finalized: false as boolean,
    /** Persisted to the real `calibrate-extrinsic` store paths. */
    saved: false as boolean,
    /** PRV step's live drag-test state; null fields until first drag. */
    preview: {
      pos: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } } as { L: Pos; R: Pos },
      cursor_l: null as Point2d | null,
      cursor_r: null as Point2d | null,
    },
    // Recording (capture-recorder-everywhere ruling 2).
    ...recordingTelemetry(),
  },
  // No session frames: the raw L/C/R previews bind the `camera:<serial>` pipe
  // via `usePipeFrame` (C-22 migration); detections/overlays ride telemetry.
  frames: [] as const,
  commands: {
    setTargetId: cmd<{ role: "L" | "C" | "R"; id: number }>(),
    /** Per-eye override slot drivers (reusable `pidOverride` fragment): `{ value }`
     *  pins that eye's output (engage/update), `{ release: true }` resumes control
     *  (the servo node's `seed` keeps it continuous). Driven by `usePidOverride`;
     *  only meaningful in the CAL step (the only step running `startServo`). */
    pidOverrideL: pidOverrideCmd<Pos>(),
    pidOverrideR: pidOverrideCmd<Pos>(),
    /** Record the currently-tracked L/C/R detections as one data point
     *  (requires all three trackers to have a target). */
    capture: cmd(),
    removeRecord: cmd<{ index: number }>(),
    clearRecords: cmd(),
    /** CAL -> FIN: also kicks off the L/R regression fit. */
    finalize: cmd(),
    setStep: cmd<{ step: "CAL" | "FIN" | "PRV" }>(),
    /** PRV: drag on the center view to test the fitted regressions —
     *  actuates both mirrors to the predicted volts for that angle. */
    setPreviewTarget: cmd<{ p: Point2d }>(),
    /** Persist `records` to the real `calibrate-extrinsic` store paths. */
    confirm: cmd(),
    // Recording (capture-recorder-everywhere ruling 2): the raw L/C/R streams.
    ...recordingCommands(),
  },
});

export type CalibrateExtrinsicContract = typeof calibrateExtrinsic;
