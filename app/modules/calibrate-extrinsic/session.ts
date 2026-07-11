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
import { mirrorHistory } from "@orchestrator/mirror-history";
import { registerGraphWiring } from "@orchestrator/graph-topology";
import { registerNativeProbe } from "@orchestrator/native-probes";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";
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
import { computeFinStats, createDataSet, MIN_FIT_SAMPLES } from "./dataset";

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

    // Per-role wall-clock stamp of the last PUBLISHED detection (review #12,
    // session half): a frozen tracker (camera loss) stops stamping, the
    // freshness ticker flips its telemetry false, and capture re-checks the
    // raw age — frozen detections are no longer capturable.
    const DETECTION_STALE_MS = 500;
    const lastDetectionAt: Record<Role, number> = { L: 0, C: 0, R: 0 };
    let lastFresh = { L: false, C: false, R: false };

    function detectionFresh(): Record<Role, boolean> {
      const t = Date.now();
      return {
        L: t - lastDetectionAt.L <= DETECTION_STALE_MS,
        C: t - lastDetectionAt.C <= DETECTION_STALE_MS,
        R: t - lastDetectionAt.R <= DETECTION_STALE_MS,
      };
    }

    function publishDetections(): void {
      if (!trackers) return;
      const views = detectionViews(trackers);
      const t = Date.now();
      for (const role of ["L", "C", "R"] as const)
        if (views[role]) lastDetectionAt[role] = t;
      s.telemetry({ detection: views });
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
        servo = startServo(trackers.L, trackers.R, {
          owner: "calibrate-extrinsic",
          kp: s.state.servoGain,
        });
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

    // Drawer gain retune (user issue 2): the servo's gain is fixed at
    // construction (velocity-form ki — see the contract note), so a LIVE
    // retune restarts it. Debounced (a slider drag writes state per tick, and
    // each restart churns the MCU stream); safe mid-run because startServo
    // re-seeds from the live applied pose — control resumes continuously.
    let servoRetuneTimer: ReturnType<typeof setTimeout> | null = null;
    function retuneServo(): void {
      if (servoRetuneTimer) clearTimeout(servoRetuneTimer);
      servoRetuneTimer = setTimeout(() => {
        servoRetuneTimer = null;
        if (s.state.step !== "CAL" || !servo || !trackers) return;
        enterStep("CAL"); // stop + restart with the current state.servoGain
      }, 200);
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
      // Teardown is LIFO (review #10): the LEASE release is registered FIRST
      // so it runs LAST — the recording defer below it finalizes while the
      // cameras are still leased (the calibrate-distortion order; the old
      // order released leases under an active recording).
      scope.defer(() => {
        releaseLeases(leases);
        leases = null;
        undistort = null;
      });
      scope.defer(async () => void (await recording.stop()));
      monitor.done("intrinsic");
      monitor.start("records");
      records = await read<ExtrinsicRecord[]>(SCRATCH_PATH, []);
      if (scope.cancelled) return; // frozen at "Loading records" (scope cancel)
      s.telemetry({ records, saved: false });
      monitor.done("records");

      // Profiler visibility (user issue 4, session half): the three detector
      // threads were metered natively but graph-INVISIBLE — register their
      // node rows + camera→detect edges + the leased triple's role labels
      // (the calibrate-drift roles precedent). The trackers default their
      // native meter name to `nodeId.detect(serial)` and expose `probe`
      // (marker-tracker.ts), so the probe registration below keys the live
      // thread stats onto exactly these node rows.
      scope.defer(
        registerGraphWiring({
          roles: {
            [matched.L.camera.serial]: "L",
            [matched.C.camera.serial]: "C",
            [matched.R.camera.serial]: "R",
          },
          nodes: (["L", "C", "R"] as const).map((role) => ({
            id: nodeId.detect(matched[role].camera.serial),
            kind: "detect",
            owner: "win/calibrate-extrinsic",
            output: { kind: "detect" } as const,
            transport: "native" as const,
          })),
          edges: (["L", "C", "R"] as const).map((role) => ({
            from: nodeId.camera(matched[role].camera.serial),
            to: nodeId.detect(matched[role].camera.serial),
            port: "frame",
            type: {
              kind: "frame",
              pixelFormat: "Mono8",
              dtype: "U8",
            } as const,
          })),
        }),
      );

      // LIVE mirror pose telemetry (user issue 3): the PosView record head
      // tracks the applied pose (kept live by applyStreamedPos on v2 / the
      // awaited actuate on v1) at a fixed throttle; deduped so an idle mirror
      // publishes nothing. Doubles as the detection-freshness ticker (#12).
      {
        let lastSent = "";
        const ticker = setInterval(() => {
          const c = activeController();
          const mirror = c?.connected ? c.pos : null;
          const key = mirror
            ? `${mirror.left.x},${mirror.left.y},${mirror.right.x},${mirror.right.y}`
            : "";
          if (key !== lastSent) {
            lastSent = key;
            s.telemetry({ mirror });
          }
          const fresh = detectionFresh();
          if (
            fresh.L !== lastFresh.L ||
            fresh.C !== lastFresh.C ||
            fresh.R !== lastFresh.R
          ) {
            lastFresh = fresh;
            s.telemetry({ detectionFresh: fresh });
          }
        }, 100);
        scope.defer(() => clearInterval(ticker));
      }

      monitor.start("trackers");
      trackers = createTrackerTriple(
        { L: leases.L.camera, C: leases.C.camera, R: leases.R.camera },
        s.state.targetId,
        { internal: true },
      );
      scope.defer(() => {
        trackers = stopTriple(trackers);
      });
      // Fold the detector threads' native ThreadMeters into perfSnapshot,
      // keyed by the SAME nodeId.detect ids as the graph rows above (the
      // trackers name their meters that way by default) — probe() is null
      // before start/after stop, so a torn-down tracker simply drops out.
      scope.defer(
        registerNativeProbe(() => {
          const out: Record<string, WorkloadSnapshot> = {};
          for (const role of ["L", "C", "R"] as const) {
            const p = trackers?.[role]?.probe;
            if (p) out[nodeId.detect(matched[role].camera.serial)] = p;
          }
          return out;
        }),
      );
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
        s.resetTelemetry(["ready", "detection", "detectionFresh", "mirror", "finalized", "fin"]);
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
          // Review #12 (session half): frozen detections (camera loss) must
          // not be capturable — every role's LAST detection must be fresh.
          const fresh = detectionFresh();
          if (!fresh.L || !fresh.C || !fresh.R) return;
          // Review L1 (TOCTOU): SNAPSHOT every tracker-derived value BEFORE
          // any await — the store read below yields, and the trackers keep
          // ticking (a mid-await retarget/loss used to mix two frames into
          // one record).
          const targetL = L.target;
          const targetC = C.target;
          const targetR = R.target;
          const centerAbsolute = C.centerAbsolute;
          const otherTargets = [...C.otherTargets];
          const targetIds = { ...s.state.targetId };
          if (!targetL || !targetC || !targetR || !centerAbsolute) return;
          // Review #9: pair the recorded image with the mirror pose AT THE
          // DETECTION FRAME's time, not "whatever the stream reached by now"
          // (worse at high stream rates). The controller-node's JS path
          // records every applied pose into the mirror-history ring with
          // host-steady stamps; each eye's frame carries the trusted
          // owner-applied timestamp in the same domain when clock-calibrated.
          // A sample farther than 1 s (uncalibrated camera clock, empty ring)
          // falls back to the live pose — the old behavior, never worse.
          const livePos = activeController()?.pos;
          if (!livePos) return;
          const alignedVolt = (frameTs: bigint | null, side: "left" | "right"): Pos => {
            if (frameTs === null) return livePos[side];
            const at = mirrorHistory.mirrorAt(frameTs);
            if (!at || at.ageNs > 1_000_000_000n) return livePos[side];
            return at[side];
          };
          const voltageL = alignedVolt(L.frame?.deviceTimestamp ?? null, "left");
          const voltageR = alignedVolt(R.frame?.deviceTimestamp ?? null, "right");
          const angle = undistort.angular([centerAbsolute], true)[0];
          // Ruling 3 (spec §capture-measurements): the wide camera's view of the
          // side markers, matched by per-eye target id; absent → center fallback.
          const sideQuad = (id: number): Point2d[] | undefined => {
            const d = otherTargets.find((o) => o.id === id);
            return d ? d.slice(0, 4).map((p) => ({ x: p.x, y: p.y })) : undefined;
          };
          const side_pts = {
            L: sideQuad(targetIds.L),
            R: sideQuad(targetIds.R),
          };
          // Ruling 2: the independently-adjustable marker sizes at capture.
          const cfg = await read<MarkerConfig>(CONFIG_PATH, {});
          const side_mm = cfg.cal_marker_size_mm ?? 60.0;
          const marker = { side_mm, center_mm: side_mm * (cfg.cal_marker_ratio ?? 1.0) };
          records = [
            ...records,
            {
              L: { img_pts: targetL.img_pts, obj_pts: targetL.obj_pts, voltage: voltageL },
              C: { img_pts: targetC.img_pts, obj_pts: targetC.obj_pts, angle, side_pts, marker },
              R: { img_pts: targetR.img_pts, obj_pts: targetR.obj_pts, voltage: voltageR },
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
          s.telemetry({ finalized: false, fin: null });
          enterStep("FIN");
          // Review #14: below the fit threshold the SVD returns a silently-
          // plausible minimum-norm solution — hard-gate the fit (the FIN UI
          // shows the count against the minimum) instead of persisting junk.
          if (records.length < MIN_FIT_SAMPLES) {
            s.telemetry({
              fin: computeFinStats(records, { L: null, R: null }),
            });
            return;
          }
          const [l, r] = await Promise.all([
            fitExtrinsicRegression(createDataSet(records, "L")).catch(() => null),
            fitExtrinsicRegression(createDataSet(records, "R")).catch(() => null),
          ]);
          fittedL = l;
          fittedR = r;
          s.telemetry({
            finalized: !!(fittedL && fittedR),
            // Review #14 (session-computable half): per-record volt-space
            // residuals of the fit that was just produced.
            fin: computeFinStats(records, {
              L: fittedL ? fittedL.A2V : null,
              R: fittedR ? fittedR.A2V : null,
            }),
          });
        },
        async setStep({ step }) {
          if (step === "PRV" && !(fittedL && fittedR)) return;
          // Review #6: FIN is a review of CAPTURED records — a `?step=FIN`
          // URL seed with nothing captured lands on an empty review with a
          // live Confirm button; bounce back to CAL instead.
          if (step === "FIN" && records.length === 0) return;
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
          // Review #6: never persist an unfitted / empty dataset — an empty
          // latest record would SHADOW older good ones at resolve time.
          if (!leases || !(fittedL && fittedR) || records.length === 0) return;
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
        servoGain() {
          retuneServo(); // debounced live restart (user issue 2)
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
