// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-extrinsic session (docs/history/refactor/orchestrator.md §7.1 S1b) —
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
// (tracker-driven visual servo, manual override via drag); PRV pushes a
// drag-computed target to the controller NODE via a paced position input
// (testing the just-fitted regressions); FIN has no actuation (static review).

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { matchTriple, retryUntil, type CameraLease } from "@orchestrator/registry";
import { loadIntrinsic, fitExtrinsicRegression } from "@orchestrator/calibration";
import { controllerNode, startPacer, type PositionInput } from "@orchestrator/controller-node";
import { startServo, type MarkerTracker, type Servo } from "@orchestrator/marker-tracker";
import { applyPidOverride } from "@orchestrator/pid-node";
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
import type { PipeBroker } from "@orchestrator/pipe-session";
import { createRawRecording } from "@orchestrator/raw-recording";
import {
  createCaptureHelper,
  rawTripleShot,
  type CaptureHelper,
} from "@orchestrator/capture-helper";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { RawPipeRegistry } from "@orchestrator/raw-pipe";
import { getCameraKey } from "@lib/camera-config";
import { type Undistort } from "core/Vision";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import type { ExtrinsicConversions } from "@lib/coordinate-conversions";
import { calibrateExtrinsic, type ExtrinsicRecord } from "./contract";
import { createDataSet } from "./dataset";

type Role = "L" | "C" | "R";
const ORIGIN: Pos = { x: 0, y: 0 };
const SCRATCH_PATH = ["tmp", "calibrate-extrinsic"];

// Config store path for the app-wide marker geometry (mirrors `useAppConfig`'s
// `Store.open("config")`; read here through the orchestrator store-hub — NOT
// `@lib/config`, which pulls Vue into this Vue-free session).
const CONFIG_PATH = ["config"];
type MarkerConfig = { cal_marker_size_mm?: number; cal_marker_ratio?: number };

export default function calibrateExtrinsicSession(
  broker: PipeBroker,
  rawPipes: RawPipeRegistry,
): ServerSession<typeof calibrateExtrinsic> {
  return defineResourceSession("calibrate-extrinsic", calibrateExtrinsic, (s) => {
    let leases: Record<Role, CameraLease> | null = null;
    // Capture (ruling 3): DEGRADED raw-stack capture — this tool holds no
    // undistort (it PRODUCES the extrinsic data), so the L/R foveae stack raw
    // WITHOUT the fovea homography wrap (stated in `capture_meta`).
    let captureHelper: CaptureHelper | null = null;
    let captureCenter: { shmName: string; maxBytes: number; channels: number } | null = null;
    let undistort: Undistort | null = null;

    // Recording (capture-recorder-everywhere ruling 2): the raw L/C/R sensor
    // streams (advert-verbatim, the OBVIOUS default set) via the shared facility.
    const recording = createRawRecording({
      id: "recorder/calibrate-extrinsic",
      broker,
      rawPipes,
      streams: () =>
        leases
          ? {
              "left-fovea": leases.L.camera,
              center: leases.C.camera,
              "right-fovea": leases.R.camera,
            }
          : null,
      finished: (foveaPath) =>
        process.parentPort?.postMessage({ type: "recording:finished", path: foveaPath }),
      telemetry: (patch) => s.telemetry(patch),
    });
    let trackers: Record<Role, MarkerTracker> | null = null;
    let servo: Servo | null = null;
    let previewInput: PositionInput | null = null;
    let previewStop: (() => void) | null = null;
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
      previewStop?.();
      previewStop = null;
      void previewInput?.close(); // terminate the MCU stream + disable-iff-we-enabled
      previewInput = null;
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
        servo = startServo(trackers.L, trackers.R, { owner: "calibrate-extrinsic" });
        // A fresh servo's per-eye override slots start released — mirror that
        // into contract state so a stale engaged echo can't survive a step
        // round-trip (CAL → FIN/PRV → CAL recreates the servo).
        s.setState("pidOverrideL", { engaged: false, value: null });
        s.setState("pidOverrideR", { engaged: false, value: null });
      } else if (step === "PRV") {
        // Push model: a paced timer pushes the drag-computed `previewVolt` to the
        // controller node (was `startActuationLoop`). No telemetry body — the PRV
        // step tests the just-fitted regressions, it doesn't mirror volts.
        previewInput = controllerNode().openPosition("calibrate-extrinsic-preview", {
          initial: { left: previewVolt.l, right: previewVolt.r },
        });
        previewStop = startPacer(1, () => {
          previewInput!.update({ left: previewVolt.l, right: previewVolt.r });
        });
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
      // Spin-up progress (ruling 2026-07-09): declared steps ride the status
      // channel so the window shows this sequence instead of blanking while the
      // graph builds. A failure/early-return leaves the list FROZEN at its step
      // (never `done`/`complete`) — the two-stage acquire freezes at "Leasing
      // cameras" on match failure, at "Loading center intrinsics" if the center
      // intrinsic is missing; idle teardown clears a cancelled spin-up.
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing cameras" },
        { id: "intrinsic", label: "Loading center intrinsics" },
        { id: "records", label: "Loading records" },
        { id: "trackers", label: "Starting trackers" },
        { id: "actuation", label: "Starting actuation" },
      ]);
      monitor.start("lease");
      const matched = await retryUntil(matchTriple);
      if (scope.cancelled) {
        if (matched) releaseLeases(matched);
        return;
      }
      if (!matched) {
        s.telemetry({ ready: false });
        s.fail("Cameras unavailable — held by another app or not connected");
        return; // frozen at "Leasing cameras"
      }
      monitor.done("lease");
      monitor.start("intrinsic");
      const { undistort: u } = await loadIntrinsic(matched.C.camera);
      if (scope.cancelled || !u) {
        releaseLeases(matched);
        if (!u) {
          s.telemetry({ ready: false });
          s.fail("Center camera intrinsic calibration unavailable");
        }
        return; // frozen at "Loading center intrinsics"
      }
      leases = matched;
      undistort = u;
      scope.defer(async () => void (await recording.stop())); // finalize before leases release (LIFO)
      scope.defer(() => {
        releaseLeases(leases);
        leases = null;
        undistort = null;
      });
      monitor.done("intrinsic");
      monitor.start("records");
      records = await read<ExtrinsicRecord[]>(SCRATCH_PATH, []);
      if (scope.cancelled) return; // frozen at "Loading records" (scope cancel)
      s.telemetry({ records, saved: false });
      monitor.done("records");

      monitor.start("trackers");
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
      monitor.done("trackers");

      monitor.start("actuation");
      enterStep(s.state.step);
      monitor.done("actuation");

      // --- capture (ruling 3, DEGRADED — no undistort) -----------------------
      const capCenterId = nodeId.convert(leases.C.camera.serial);
      const capCenter = broker.connect(capCenterId);
      scope.defer(() => void broker.disconnect(capCenterId));
      captureCenter = {
        shmName: capCenter.shmName,
        maxBytes: capCenter.spec.maxBytes ?? capCenter.spec.bytesPerFrame,
        channels: capCenter.spec.channels,
      };
      scope.defer(() => {
        captureCenter = null;
      });
      captureHelper = createCaptureHelper({
        id: nodeId.win("calibrate-extrinsic", "capture"),
        broker,
        rawPipes,
        graphInputs: {
          left: `camera/${leases.L.camera.serial}/raw`,
          right: `camera/${leases.R.camera.serial}/raw`,
          center: capCenterId,
        },
        cameras: () =>
          leases ? { left: leases.L.camera, right: leases.R.camera } : null,
        centerPipe: () => captureCenter,
        snapshot: (reset, indexed) =>
          leases
            ? rawTripleShot({
                reset,
                indexed,
                stackCount: 5,
                note: "calibrate-extrinsic: no undistort (pre-calibration) — raw stacks, no wrap",
              })
            : null,
        recordingActive: () => recording.active,
        telemetry: (patch) => s.telemetry(patch),
      });
      captureHelper.build();
      scope.defer(async () => {
        await captureHelper?.activeCapture;
        await captureHelper?.stop();
        captureHelper = null;
      });

      s.telemetry({ ready: true });
      monitor.complete(); // spin-up finished — clear the overlay
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
        async pidOverrideL(command) {
          if (!servo?.override.left) return;
          s.setState("pidOverrideL", applyPidOverride(servo.override.left, command));
        },
        async pidOverrideR(command) {
          if (!servo?.override.right) return;
          s.setState("pidOverrideR", applyPidOverride(servo.override.right, command));
        },
        async capture() {
          if (!trackers || !undistort) return;
          const { L, C, R } = trackers;
          const pos = activeController()?.pos;
          const centerAbsolute = C.centerAbsolute;
          if (!L.target || !C.target || !R.target || !pos || !centerAbsolute) return;
          const angle = undistort.angular([centerAbsolute], true)[0];
          // Ruling 3: the WIDE (C) camera's raw view of the SIDE markers (the
          // SAME physical markers the L/R foveae track). `C.otherTargets` holds
          // C's non-target detections this tick; match by the per-eye target id
          // and record its outer 4-corner quad (absent when the wide camera
          // didn't see that side marker → that eye's record has no preferred
          // measurement, falls back to the center marker).
          const sideQuad = (id: number): Point2d[] | undefined => {
            const d = C.otherTargets.find((o) => o.id === id);
            return d ? d.slice(0, 4).map((p) => ({ x: p.x, y: p.y })) : undefined;
          };
          const side_pts = {
            L: sideQuad(s.state.targetId.L),
            R: sideQuad(s.state.targetId.R),
          };
          // Ruling 2: the (independently-adjustable) marker sizes at capture,
          // read from the store-hub-cached app config — side markers vs center.
          const cfg = await read<MarkerConfig>(CONFIG_PATH, {});
          const side_mm = cfg.cal_marker_size_mm ?? 60.0;
          const marker = { side_mm, center_mm: side_mm * (cfg.cal_marker_ratio ?? 1.0) };
          records = [
            ...records,
            {
              L: { img_pts: L.target.img_pts, obj_pts: L.target.obj_pts, voltage: pos.left },
              C: { img_pts: C.target.img_pts, obj_pts: C.target.obj_pts, angle, side_pts, marker },
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
          // input); found while porting, fixed here. See docs/history/refactor/
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
        // Capture (ruling 3) — forward to the shared helper.
        async captureShot({ tag }) {
          if (!captureHelper) throw new Error("Capture not ready");
          await captureHelper.captureShot(tag);
        },
        async getCapturePreview({ resource, index }) {
          return captureHelper ? captureHelper.getPreview(resource, index) : null;
        },
        async saveCapture({ path, format }) {
          await captureHelper?.save(path, format);
        },
        async discardCapture() {
          await captureHelper?.discard();
        },
        async startRecording({ path }) {
          if (captureHelper?.capturing) return false; // exclusivity (ruling 6)
          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
        },
      },
      watch: {
        step(step) {
          enterStep(step);
        },
      },
      busy() {
        if (captureHelper?.capturing) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}
