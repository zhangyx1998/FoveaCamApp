// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the calibrate-extrinsic session — a 3-step wizard building
// the per-fovea extrinsic dataset. `records` are plain serializable data, so
// they ride telemetry directly. Behavior spec: docs/spec/calibrate-extrinsic.md.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import {
  pidOverrideCmd,
  pidOverrideState,
} from "@lib/orchestrator/pid-override-contract";
import type { Point2d, Point3d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { captureCommands, captureTelemetry, recordingCommands, recordingTelemetry } from "@lib/orchestrator/contracts";

export type TrackerRecord = { img_pts: Point2d[]; obj_pts: Point3d[] };
export type ExtrinsicRecord = {
  L: TrackerRecord & { voltage: Point2d };
  C: TrackerRecord & {
    angle: Point2d;
    /** Measured-magnification inputs on the wide camera (both optional; spec
     *  §capture-measurements). `side_pts`: the wide view of the side markers
     *  (ruling 3); `marker`: the marker sizes at capture (ruling 2 fallback). */
    side_pts?: { L?: Point2d[]; R?: Point2d[] };
    marker?: { side_mm: number; center_mm: number };
  };
  R: TrackerRecord & { voltage: Point2d };
};

export type DetectionView = { points: Point2d[] } | null;

/** FIN-step fit-quality stats (review #14, session-computable half): sample
 *  count vs the fit-gate minimum + per-record volt-space residuals (predicted
 *  vs recorded voltage at each record's angle) + per-eye RMS. */
export type FinStats = {
  samples: number;
  minSamples: number;
  residuals: Array<{ L: number | null; R: number | null }>;
  rmsL: number | null;
  rmsR: number | null;
};

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
    /** The leased triple's config store path (`["triples", <hash>]`), or []
     *  pre-lease — the renderer opens this doc reactively to read the per-triple
     *  `baseline_mm` for LIVE marker spacing (per-triplet-settings wave,
     *  `useTripleBaseline`). Set on acquire. */
    configPath: [] as string[],
    /** CAL visual-servo gain (velocity-form: `startServo`'s single `kp`, which
     *  maps to `ki` internally — kp/kd are structurally 0 in this control law).
     *  Drawer-tunable; the session restarts the servo (debounced) on change —
     *  the servo re-seeds from the live pose, so retuning never snaps. */
    servoGain: 16,
  },
  telemetry: {
    ready: false as boolean,
    detection: { L: null, C: null, R: null } as Record<"L" | "C" | "R", DetectionView>,
    /** Per-role detection FRESHNESS (review #12, session half): false once a
     *  role's last detection is older than the staleness bound — a frozen
     *  tracker (camera loss) must not stay capturable. */
    detectionFresh: { L: false, C: false, R: false } as Record<"L" | "C" | "R", boolean>,
    /** LIVE mirror pose during CAL (the PosView record head) — fed at a fixed
     *  throttle from the controller's applied pose, so the head tracks servo
     *  motion + drags in realtime. Null = no controller bound. */
    mirror: null as { left: Pos; right: Pos } | null,
    /** FIN fit-quality stats (review #14) — null until a finalize ran. */
    fin: null as FinStats | null,
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
    ...captureTelemetry(),
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
    ...captureCommands(),
    ...recordingCommands(),
  },
});

export type CalibrateExtrinsicContract = typeof calibrateExtrinsic;
