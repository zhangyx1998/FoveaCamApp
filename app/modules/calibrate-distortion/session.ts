// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-distortion session — projector-alignment/homography validation.
// Three MarkerTrackers; the center's observed angle points both mirrors (pushed
// to the controller node per detection tick). Per-fovea projection: main
// computes a 4-point homography per detection and ships it to the `distortion`
// vision worker, which does the heavy `wrapPerspective` off the JS loop.

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { registerGraphWiring } from "@orchestrator/graph-topology";
import { controllerNode, type PositionInput } from "@orchestrator/controller-node";
import { findHomography } from "core/Vision";
import { area, type Point2d } from "core/Geometry";
import { type MarkerTracker } from "@orchestrator/marker-tracker";
import { publishSerials, DisposerBag, releaseLeases } from "@orchestrator/session-resources";
import { detectionViews, retarget } from "@orchestrator/marker-calibration";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeBroker } from "@orchestrator/pipe-session";
import { createRawRecording } from "@orchestrator/raw-recording";
import {
  createCaptureHelper,
  rawTripleShot,
  type CaptureHelper,
} from "@orchestrator/capture-helper";
import type { RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import {
  bilinearInterpolate,
  CORNER_OBJ_POINTS,
  relativeToAbsolute,
  transformPoints,
} from "@lib/marker";
import { makeMat } from "@lib/mat";
import { createTrackerTriple, stopTriple } from "@orchestrator/marker-calibration";
import type { Pos } from "@lib/controller-codec";
import { calibrateDistortion, type ProjectionView } from "./contract";

type Role = "L" | "C" | "R";
const ORIGIN: Pos = { x: 0, y: 0 };

export default function calibrateDistortionSession(
  broker: PipeBroker,
  rawPipes: RawPipeRegistry,
  compress?: CompressPipeSeam,
): ServerSession<typeof calibrateDistortion> {
  return defineResourceSession("calibrate-distortion", calibrateDistortion, (s) => {
    let triple: CalibratedTriple | null = null;
    // Capture: degraded raw-stack over the leased triple (no per-shot mirror pose → no wrap).
    let captureHelper: CaptureHelper | null = null;
    let captureCenter: { shmName: string; maxBytes: number; channels: number } | null = null;
    let trackers: Record<Role, MarkerTracker> | null = null;
    let posInput: PositionInput | null = null;
    let worker: VisionWorkerHandle | null = null;
    let centerAngle: Point2d | null = null;
    const projBusy: Record<"L" | "R", boolean> = { L: false, R: false };

    // Recording — the raw L/C/R sensor streams (advert-verbatim).
    const recording = createRawRecording({
      id: "recorder/calibrate-distortion",
      broker,
      rawPipes,
      compress,
      streams: () =>
        triple
          ? {
              "left-fovea": triple.leases.L.camera,
              center: triple.leases.C.camera,
              "right-fovea": triple.leases.R.camera,
            }
          : null,
      finished: (foveaPath) =>
        process.parentPort?.postMessage({ type: "recording:finished", path: foveaPath }),
      telemetry: (patch) => s.telemetry(patch),
    });

    function publishDetections(): void {
      if (!trackers) return;
      s.telemetry({ detection: detectionViews(trackers) });
    }

    // Local mirror (telemetry is publish-only) so one role's update doesn't
    // clobber the other's.
    let projection: Record<"L" | "R", ProjectionView> = { L: null, R: null };

    function onCenterDetection(): void {
      if (!triple?.undistort || !trackers) return;
      const c = trackers.C.centerAbsolute;
      centerAngle = c ? triple.undistort.angular([c], true)[0] : null;
      pushTarget();
      publishDetections();
    }

    /** Push the mirror target from the center marker (origin when lost). Cadence =
     *  the center detection tick (the only place `centerAngle` changes); the MCU
     *  stream holds position between pushes. */
    function pushTarget(): void {
      if (!posInput || !triple) return;
      posInput.update(
        centerAngle
          ? { left: triple.conv.A2V.L(centerAngle), right: triple.conv.A2V.R(centerAngle) }
          : { left: ORIGIN, right: ORIGIN },
      );
    }

    // Compute one fovea's projection homography (per detection tick) and ship it
    // to the worker, which does the heavy `wrapPerspective`.
    async function computeProjection(role: "L" | "R"): Promise<void> {
      if (!trackers || projBusy[role]) return;
      const target = trackers[role].target;
      const c = trackers[role].centerAbsolute;
      if (!target || !c || !centerAngle) return;
      projBusy[role] = true;
      try {
        const scale = Math.sqrt(area(target));
        const dst_corners = relativeToAbsolute(
          transformPoints(CORNER_OBJ_POINTS, centerAngle, 1000),
          c,
          scale,
        );
        const dst_img_pts = bilinearInterpolate(dst_corners, target.obj_pts);
        const H = await findHomography(target.img_pts, dst_img_pts);
        const Hnums = Array.from(H as unknown as ArrayLike<number>);
        worker?.sendParams({ [`homography${role}`]: Hnums });
        projection = { ...projection, [role]: { H: Hnums, points: dst_img_pts } };
        s.telemetry({ projection });
      } catch (e) {
        console.error(`[calibrate-distortion] projection ${role}:`, e);
      } finally {
        projBusy[role] = false;
      }
    }

    // The worker posts only the warped overlays ("proj_L"/"proj_R").
    function onResult(r: VisionResult): void {
      for (const f of r.frames) {
        s.frame(f.name, makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels));
      }
    }

    function connectPipe(role: "L" | "R", serial: string, ids: string[]): PipeInput {
      const pipeId = nodeId.convert(serial);
      const handle = broker.connect(pipeId);
      ids.push(pipeId);
      const { width, height, channels, bytesPerFrame, maxBytes } = handle.spec;
      return { role, shmName: handle.shmName, width, height, channels, bytesPerFrame: maxBytes ?? bytesPerFrame };
    }

    // Resource-scoped activation: cleanups drain LIFO on idle; leases release LAST.
    async function activateSession(scope: ResourceScope): Promise<void> {
      // The progress monitor freezes at the step an early-return died on.
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing cameras" },
        { id: "trackers", label: "Starting trackers" },
        { id: "worker", label: "Starting vision worker" },
        { id: "controller", label: "Wiring controller" },
      ]);
      monitor.start("lease");
      const t = await scope.use(() => acquireTriple(s), releaseLeases);
      if (!t) return; // frozen at "Leasing cameras" (contention/fail)
      monitor.done("lease");
      triple = t;
      // DISPLAY-ONLY: label the leased triple by role (L/C/R) in the profiler.
      scope.defer(
        registerGraphWiring({
          roles: {
            [t.leases.L.camera.serial]: "L",
            [t.leases.C.camera.serial]: "C",
            [t.leases.R.camera.serial]: "R",
          },
          nodes: [],
          edges: [],
        }),
      );
      scope.defer(async () => void (await recording.stop())); // finalize before leases release (LIFO)
      scope.defer(() => {
        triple = null;
      });
      monitor.start("trackers");
      trackers = createTrackerTriple(
        { L: t.leases.L.camera, C: t.leases.C.camera, R: t.leases.R.camera },
        s.state.targetId,
        { internal: true },
      );
      scope.defer(() => {
        trackers = stopTriple(trackers);
      });
      monitor.done("trackers");

      monitor.start("worker");
      const pipeIds: string[] = [];
      const pipes: PipeInput[] = [
        connectPipe("L", t.leases.L.camera.serial, pipeIds),
        connectPipe("R", t.leases.R.camera.serial, pipeIds),
      ];
      worker = createVisionWorker(
        {
          pipes,
          params: { kind: "distortion" },
          meterName: nodeId.win("calibrate-distortion", "distortion"), // kernel self-meter
        },
        onResult,
      );
      scope.defer(() => {
        worker?.terminate();
        worker = null;
        for (const id of pipeIds) broker.disconnect(id);
      });
      monitor.done("worker");

      monitor.start("controller");
      // Detection subscriptions — each fovea recomputes+ships its projection on
      // its own detection; the center recomputes both (it moves `centerAngle`).
      const taps = new DisposerBag();
      taps.push(
        trackers.L.onDetection(() => {
          publishDetections();
          void computeProjection("L");
        }),
      );
      taps.push(
        trackers.C.onDetection(() => {
          onCenterDetection();
          void computeProjection("L");
          void computeProjection("R");
        }),
      );
      taps.push(
        trackers.R.onDetection(() => {
          publishDetections();
          void computeProjection("R");
        }),
      );
      publishSerials(t.leases, taps, s);
      // Publish the triple's config path so the renderer opens the per-triple doc
      // for live marker spacing.
      s.setState("configPath", t.configPath);
      scope.defer(() => s.setState("configPath", []));
      scope.defer(() => taps.dispose());

      // Controller-node position input: park at origin until the first center
      // detection retargets the mirrors.
      posInput = controllerNode().openPosition("calibrate-distortion", {
        from: nodeId.detect(t.leases.C.camera.serial),
        initial: { left: ORIGIN, right: ORIGIN },
      });
      pushTarget();
      scope.defer(() => {
        void posInput?.close(); // terminate the MCU stream + disable-iff-we-enabled
        posInput = null;
      });

      // --- capture -----------------------------------------------------------
      // Persistent capture-center pipe (C convert; one-shot read), then the idle node.
      const capCenterId = nodeId.convert(t.leases.C.camera.serial);
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
        id: nodeId.win("calibrate-distortion", "capture"),
        broker,
        rawPipes,
        graphInputs: {
          left: `camera/${t.leases.L.camera.serial}/raw`,
          right: `camera/${t.leases.R.camera.serial}/raw`,
          center: capCenterId,
        },
        cameras: () =>
          triple ? { left: triple.leases.L.camera, right: triple.leases.R.camera } : null,
        centerPipe: () => captureCenter,
        snapshot: (reset, indexed) =>
          triple
            ? rawTripleShot({
                reset,
                indexed,
                stackCount: 5,
                note: "calibrate-distortion: raw stacks, no per-shot mirror pose (no wrap)",
              })
            : null,
        recordingActive: () => recording.active,
        telemetry: (patch) => s.telemetry(patch),
      });
      captureHelper.build();
      // Drain an in-flight shot + stop the node while the center pipe + cameras
      // are still live (before leases release).
      scope.defer(async () => {
        await captureHelper?.activeCapture;
        await captureHelper?.stop();
        captureHelper = null;
      });

      monitor.done("controller");
      s.telemetry({ ready: true });
      monitor.complete(); // spin-up finished — clear the overlay
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        centerAngle = null;
        projection = { L: null, R: null };
        s.resetTelemetry(["ready", "detection", "projection"]);
      },
      commands: {
        async setTargetId({ role, id }) {
          s.setState("targetId", { ...s.state.targetId, [role]: id });
          retarget(trackers, role, id);
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
          if (captureHelper?.capturing) return false; // exclusivity

          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
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
