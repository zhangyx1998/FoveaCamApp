// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-extrinsic session (docs/refactor/orchestrator.md §7.1 S1b) —
// the largest/highest-risk migration in the roadmap: a 3-step wizard
// (CAL capture -> FIN review/regression-fit -> PRV interactive test)
// building the per-fovea extrinsic dataset that `orchestrator/
// calibration.ts`'s `loadExtrinsic`/`leaseCalibratedTriple` consume.
//
// Deliberately does NOT use `leaseCalibratedTriple()` — that requires
// *existing* extrinsic data, which is exactly what this tool produces.
// Matches the original renderer's own dependency shape: role-matched
// cameras (`matchTriple`) + the center camera's intrinsic calibration only
// (`loadIntrinsic`, exported from `calibration.ts`).
//
// Actuation mode switches with the wizard step: CAL runs `startServo`
// (tracker-driven visual servo, manual override via drag); PRV runs a
// direct `startActuationLoop` against a drag-computed target (testing the
// just-fitted regressions); FIN has no actuation (static review).

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { matchTriple, retryUntil, type CameraLease } from "@orchestrator/registry";
import { loadIntrinsic, fitExtrinsicRegression } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { startServo, type MarkerTracker, type Servo } from "@orchestrator/marker-tracker";
import { publishSerials, DisposerBag, releaseLeases } from "@orchestrator/session-resources";
import {
  bindDetections,
  createTrackerTriple,
  detectionViews,
  retarget,
  stopTriple,
} from "@orchestrator/marker-calibration";
import { read, write } from "@orchestrator/store-hub";
import { activeController } from "@orchestrator/controller";
import { getCameraKey } from "@lib/camera-config";
import { type Undistort } from "core/Vision";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import type { ExtrinsicDataset } from "@lib/camera-config";
import type { ExtrinsicConversions } from "@lib/coordinate-conversions";
import { calibrateExtrinsic, type ExtrinsicRecord } from "./contract";

type Role = "L" | "C" | "R";
const ORIGIN: Pos = { x: 0, y: 0 };
const SCRATCH_PATH = ["tmp", "calibrate-extrinsic"];

/** Reshape captured records into the per-fovea dataset shape
 *  `loadExtrinsic`/`fitExtrinsicRegression` consume. */
function createDataSet(records: ExtrinsicRecord[], key: "L" | "R"): ExtrinsicDataset {
  return records.map((r) => ({
    img_points: r[key].img_pts,
    obj_points: r[key].obj_pts,
    voltage: r[key].voltage,
    angle: r.C.angle,
  }));
}

export default function calibrateExtrinsicSession(): ServerSession<typeof calibrateExtrinsic> {
  return defineResourceSession("calibrate-extrinsic", calibrateExtrinsic, (s) => {
    let leases: Record<Role, CameraLease> | null = null;
    let undistort: Undistort | null = null;
    let trackers: Record<Role, MarkerTracker> | null = null;
    let servo: Servo | null = null;
    let preview: ActuationLoop | null = null;
    let previewVolt: { l: Pos; r: Pos } = { l: ORIGIN, r: ORIGIN };
    let records: ExtrinsicRecord[] = [];
    let fittedL: ExtrinsicConversions | null = null;
    let fittedR: ExtrinsicConversions | null = null;

    function publishDetections(): void {
      if (!trackers) return;
      s.telemetry({ detection: detectionViews(trackers) });
    }

    function stopServo(): void {
      servo?.stop();
      servo = null;
    }
    function stopPreview(): void {
      preview?.stop();
      preview = null;
    }

    /** Switch the active actuation mode to match the wizard step. Called
     *  both at activation (for the initial step) and whenever `step`
     *  changes — `s.setState()` doesn't fire `watch` hooks for server-
     *  initiated changes (only client-initiated ones), so command handlers
     *  that change `step` call this directly too. */
    function enterStep(step: "CAL" | "FIN" | "PRV"): void {
      stopServo();
      stopPreview();
      if (!trackers) return;
      if (step === "CAL") {
        servo = startServo(trackers.L, trackers.R, {
          overrideLeft: () => s.state.override_left,
          overrideRight: () => s.state.override_right,
        });
      } else if (step === "PRV") {
        preview = startActuationLoop({ targetVolts: () => previewVolt, onVolts() {} });
      }
    }

    async function persistRecords(): Promise<void> {
      await write(SCRATCH_PATH, records);
      s.telemetry({ records, saved: false });
    }

    // Resource-scoped activation (A-P1). Two-stage acquire (matchTriple then
    // center-intrinsic load) releases IMMEDIATELY on either failure — the lease
    // only becomes scope-owned (deferred release) once both succeed. servo/
    // preview toggle per wizard step via `enterStep`; the scope's drain stops
    // whichever is active. Lease releases LAST.
    async function activateSession(scope: ResourceScope): Promise<void> {
      const matched = await retryUntil(matchTriple);
      if (scope.cancelled) {
        if (matched) releaseLeases(matched);
        return;
      }
      if (!matched) {
        s.telemetry({ ready: false });
        s.fail("Cameras unavailable — held by another app or not connected");
        return;
      }
      const { undistort: u } = await loadIntrinsic(matched.C.camera);
      if (scope.cancelled || !u) {
        releaseLeases(matched);
        if (!u) {
          s.telemetry({ ready: false });
          s.fail("Center camera intrinsic calibration unavailable");
        }
        return;
      }
      leases = matched;
      undistort = u;
      scope.defer(() => {
        releaseLeases(leases);
        leases = null;
        undistort = null;
      });
      records = await read<ExtrinsicRecord[]>(SCRATCH_PATH, []);
      if (scope.cancelled) return;
      s.telemetry({ records, saved: false });

      trackers = createTrackerTriple(
        { L: leases.L.camera, C: leases.C.camera, R: leases.R.camera },
        s.state.targetId,
        { internal: true },
      );
      scope.defer(() => {
        trackers = stopTriple(trackers);
      });
      const taps = new DisposerBag();
      bindDetections(trackers, taps, publishDetections);
      // Raw L/C/R previews ride the native `camera:<serial>` pipe (usePipeFrame
      // in index.vue, discovered via publishSerials) — no JS `onView` view-tap
      // (A-31, real-1f step 3). Marker detection stays off-loop on
      // `detector.stream`, so this session no longer taps `onView` at all.
      publishSerials(leases, taps, s);
      scope.defer(() => taps.dispose());
      // Drains FIRST: stop whichever actuation `enterStep` currently has active.
      scope.defer(() => {
        stopServo();
        stopPreview();
      });

      enterStep(s.state.step);
      s.telemetry({ ready: true });
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        fittedL = fittedR = null;
        s.resetTelemetry(["ready", "detection", "finalized"]);
      },
      commands: {
        async setTargetId({ role, id }) {
          s.setState("targetId", { ...s.state.targetId, [role]: id });
          retarget(trackers, role, id);
        },
        async setOverride({ role, pos }) {
          s.setState(role === "left" ? "override_left" : "override_right", pos);
        },
        async capture() {
          if (!trackers || !undistort) return;
          const { L, C, R } = trackers;
          const pos = activeController()?.pos;
          const centerAbsolute = C.centerAbsolute;
          if (!L.target || !C.target || !R.target || !pos || !centerAbsolute) return;
          const angle = undistort.angular([centerAbsolute], true)[0];
          records = [
            ...records,
            {
              L: { img_pts: L.target.img_pts, obj_pts: L.target.obj_pts, voltage: pos.left },
              C: { img_pts: C.target.img_pts, obj_pts: C.target.obj_pts, angle },
              R: { img_pts: R.target.img_pts, obj_pts: R.target.obj_pts, voltage: pos.right },
            },
          ];
          await persistRecords();
        },
        async removeRecord({ index }) {
          records = records.filter((_, i) => i !== index);
          await persistRecords();
        },
        async clearRecords() {
          records = [];
          await persistRecords();
        },
        async finalize() {
          s.setState("step", "FIN");
          fittedL = fittedR = null;
          s.telemetry({ finalized: false });
          enterStep("FIN");
          const [l, r] = await Promise.all([
            fitExtrinsicRegression(createDataSet(records, "L")).catch(() => null),
            fitExtrinsicRegression(createDataSet(records, "R")).catch(() => null),
          ]);
          fittedL = l;
          fittedR = r;
          s.telemetry({ finalized: !!(fittedL && fittedR) });
        },
        async setStep({ step }) {
          if (step === "PRV" && !(fittedL && fittedR)) return;
          s.setState("step", step);
          enterStep(step);
        },
        async setPreviewTarget({ p }) {
          if (!undistort || !fittedL || !fittedR) return;
          const [angle] = undistort.angular([p], true);
          // Angle -> volt (A2V), not the reverse — the original renderer's
          // preview.vue had this call backwards (`V2A.predict` on an angle
          // input); found while porting, fixed here. See docs/refactor/
          // orchestrator.md §7.1 S1b for the full note.
          const l = fittedL.A2V.predict(angle);
          const r = fittedR.A2V.predict(angle);
          previewVolt = { l, r };
          // Round-trip each predicted volt back through V2A -> angle -> pixel,
          // for the "does this look right on the wide view" overlay.
          const cursor_l = undistort.position([fittedL.V2A.predict(l)], true)[0];
          const cursor_r = undistort.position([fittedR.V2A.predict(r)], true)[0];
          s.telemetry({ preview: { pos: { L: l, R: r }, cursor_l, cursor_r } });
        },
        async confirm() {
          if (!leases) return;
          await write(["calibrate-extrinsic", getCameraKey(leases.L.camera)], createDataSet(records, "L"));
          await write(["calibrate-extrinsic", getCameraKey(leases.R.camera)], createDataSet(records, "R"));
          s.telemetry({ saved: true });
        },
      },
      watch: {
        step(step) {
          enterStep(step);
        },
      },
    };
  });
}
