// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-extrinsic session — a 3-step wizard (CAL capture → FIN
// review/regression-fit → PRV interactive test) building the per-fovea extrinsic
// dataset. Behavior spec: docs/spec/calibrate-extrinsic.md.

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { matchTriple, retryUntil, type CameraLease } from "@orchestrator/registry";
import { loadIntrinsic, fitExtrinsicRegression, tripleConfigPath } from "@orchestrator/calibration";
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
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import { getCameraKey } from "@lib/camera-config";
import {
  EXTRINSIC_STORE,
  addAssociation,
  extrinsicInner,
  makeRecord,
  recordId,
  type CalibrationRecord,
} from "@lib/calibration-records";
import { type Undistort } from "core/Vision";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import type { ExtrinsicConversions } from "@lib/coordinate-conversions";
import { calibrateExtrinsic, type ExtrinsicRecord } from "./contract";
import { createDataSet } from "./dataset";

type Role = "L" | "C" | "R";
const ORIGIN: Pos = { x: 0, y: 0 };
const SCRATCH_PATH = ["tmp", "calibrate-extrinsic"];

/** Persist one eye's finalized dataset as a content-hashed record bound to this
 *  camera + triple; identical datasets just gain the association (spec §persistence). */
async function saveExtrinsicRecord(
  role: "L" | "R",
  camera: Pick<import("core/Aravis").Camera, "vendor" | "model" | "serial">,
  dataset: import("@lib/camera-config").ExtrinsicDataset,
  tripleHash: string,
): Promise<void> {
  const cameraKey = getCameraKey(camera);
  const inner = extrinsicInner(dataset);
  const id = await recordId(inner);
  const existing = await read<CalibrationRecord | null>([EXTRINSIC_STORE, id], null);
  const assoc = { cameraKey, tripleHash, role };
  const record =
    existing && existing.inner
      ? addAssociation(existing, assoc)
      : await makeRecord(inner, {
          created: new Date().toISOString(),
          associations: [assoc],
        });
  await write([EXTRINSIC_STORE, id], record);
}

// Config store path for the app-wide marker geometry (mirrors `useAppConfig`'s
// `Store.open("config")`; read here through the orchestrator store-hub — NOT
// `@lib/config`, which pulls Vue into this Vue-free session).
const CONFIG_PATH = ["config"];
type MarkerConfig = { cal_marker_size_mm?: number; cal_marker_ratio?: number };

export default function calibrateExtrinsicSession(
  broker: PipeBroker,
  rawPipes: RawPipeRegistry,
  compress?: CompressPipeSeam,
): ServerSession<typeof calibrateExtrinsic> {
  return defineResourceSession("calibrate-extrinsic", calibrateExtrinsic, (s) => {
    let leases: Record<Role, CameraLease> | null = null;
    // Capture: DEGRADED raw-stack (no undistort — this tool produces it; spec §capture).
    let captureHelper: CaptureHelper | null = null;
    let captureCenter: { shmName: string; maxBytes: number; channels: number } | null = null;
    let undistort: Undistort | null = null;

    // Recording — the raw L/C/R sensor streams (spec §capture).
    const recording = createRawRecording({
      id: "recorder/calibrate-extrinsic",
      broker,
      rawPipes,
      compress,
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

    /** Switch actuation to match the wizard step (spec §wizard). Called at
     *  activation and on every `step` change — command handlers that change
     *  `step` call it directly since `s.setState` doesn't fire `watch` server-side. */
    function enterStep(step: "CAL" | "FIN" | "PRV"): void {
      stopServo();
      stopPreview();
      if (!trackers) return;
      if (step === "CAL") {
        servo = startServo(trackers.L, trackers.R, { owner: "calibrate-extrinsic" });
        // Mirror the fresh servo's released override slots into state so a stale
        // engaged echo can't survive a step round-trip (spec §wizard).
        s.setState("pidOverrideL", { engaged: false, value: null });
        s.setState("pidOverrideR", { engaged: false, value: null });
      } else if (step === "PRV") {
        // Push the drag-computed `previewVolt` to the controller node (spec §wizard).
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

    // Resource-scoped activation (spec §teardown): two-stage acquire releases
    // immediately on either failure; the lease is scope-owned only once both
    // succeed. The progress monitor freezes at the step an early-return died on.
    async function activateSession(scope: ResourceScope): Promise<void> {
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
      // Raw L/C/R previews ride the native `camera:<serial>` pipe (usePipeFrame).
      publishSerials(leases, taps, s);
      // Publish the triple's config path so the renderer opens the per-triple doc
      // for live marker spacing.
      s.setState(
        "configPath",
        await tripleConfigPath(leases.L.camera, leases.C.camera, leases.R.camera),
      );
      scope.defer(() => s.setState("configPath", []));
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
          // Ruling 3 (spec §capture-measurements): the wide camera's view of the
          // side markers, matched by per-eye target id; absent → center fallback.
          const sideQuad = (id: number): Point2d[] | undefined => {
            const d = C.otherTargets.find((o) => o.id === id);
            return d ? d.slice(0, 4).map((p) => ({ x: p.x, y: p.y })) : undefined;
          };
          const side_pts = {
            L: sideQuad(s.state.targetId.L),
            R: sideQuad(s.state.targetId.R),
          };
          // Ruling 2: the independently-adjustable marker sizes at capture.
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
          // angle → volt (A2V), NOT the reverse (spec §capture-measurements).
          const l = fittedL.A2V.predict(angle);
          const r = fittedR.A2V.predict(angle);
          previewVolt = { l, r };
          // Round-trip each volt back through V2A → angle → pixel for the overlay.
          const cursor_l = undistort.position([fittedL.V2A.predict(l)], true)[0];
          const cursor_r = undistort.position([fittedR.V2A.predict(r)], true)[0];
          s.telemetry({ preview: { pos: { L: l, R: r }, cursor_l, cursor_r } });
        },
        async confirm() {
          if (!leases) return;
          // Persist each eye's dataset as a content-hashed record (spec §persistence).
          const [, tripleHash] = await tripleConfigPath(
            leases.L.camera,
            leases.C.camera,
            leases.R.camera,
          );
          await saveExtrinsicRecord("L", leases.L.camera, createDataSet(records, "L"), tripleHash);
          await saveExtrinsicRecord("R", leases.R.camera, createDataSet(records, "R"), tripleHash);
          s.telemetry({ saved: true });
        },
        // Capture — forward to the shared helper.
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
          if (captureHelper?.capturing) return false; // exclusivity (spec §capture)
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
