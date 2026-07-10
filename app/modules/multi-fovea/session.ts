// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Multi-fovea session (C-24 step 4 — the composition-round flagship).
// Tracking runs on B-25's native multi-KCF thread (`createMultiTracker`: one
// free-running thread, batched per-frame results, fused undistort — results in
// UNDISTORTED coordinates when calibrated). The session consumes the batch
// iterator into the runtime's policy half (arm/disarm churn, lost tolerance,
// steering, controller streams) and drives each slot's composed fovea crop
// node (`setFoveaRect` per tick — frame-bound origin rides the pipe, v4).
// The renderer COMPOSES the per-target fovea nodes itself (camera-rooted,
// refcounted, auto-unref on window close) and binds them via `usePipeFrame`.
// The C-22b relay worker is GONE — nothing multi-fovea does touches the JS
// event loop per frame anymore.

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { activeController, type StreamHandle } from "@orchestrator/controller";
import { RoundRobinFrameScheduler } from "@orchestrator/scheduler";
import { publishSerials, releaseLeases } from "@orchestrator/session-resources";
import {
  advertiseHomographyUndistortPipe,
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import {
  conversionComputeH,
  startHomographyFeeder,
} from "@orchestrator/homography-feeder";
import { pushHomography } from "core/Aravis";
import { registerNativeProbe } from "@orchestrator/native-probes";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";
import type { RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import type { PairPipeSeam, PairHandle } from "@orchestrator/pair-pipe";
import {
  createPairedStereoPipe,
  type StereoHandle,
  type StereoPipeSeam,
} from "@orchestrator/stereo-pipe";
import {
  anchorNode,
  anchorNodeId,
  resolvedAnchorFromRecord,
} from "@orchestrator/anchor-node";
import { controllerNode } from "@orchestrator/controller-node";
import { matToArray } from "@lib/mat";
import { multiFovea, demoPresetTarget, defaultMultiFoveaTarget, clampPresetAngle, MAX_MULTI_FOVEA_TARGETS } from "./contract";
import { MultiFoveaRuntime, type MultiTrackBatch } from "./runtime";
import { createMultiFoveaRecording, type RecordingCamera } from "./recording";
import {
  createCaptureHelper,
  rawTripleShot,
  type CaptureHelper,
} from "@orchestrator/capture-helper";
import * as Tracker from "core/Tracker";
import type { Point2d, Rect } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { inverseTriangulate } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";

const ORIGIN: Pos = { x: 0, y: 0 };

function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** B-25's multi-KCF surface (d.ts pending — B-owned; cast like the Aravis pipe
 *  NAPIs). `arm` on a live id RE-INITS that target (ruled steer-while-armed). */
interface MultiKcfTracker extends AsyncIterable<MultiTrackBatch> {
  arm(id: string, roi: Rect): void;
  disarm(id: string): void;
  probe(): Tracker.TrackerMeter;
  release(): void;
}
const createMultiTracker = (
  Tracker as unknown as {
    createMultiTracker(
      camera: unknown,
      opts: { cal?: unknown; name?: string },
    ): MultiKcfTracker;
  }
).createMultiTracker;

/** The live-rect half of the fovea brick (index.ts wires `Aravis.setFoveaRect`;
 *  injected so this session stays core-free in vitest). Returns false when the
 *  pipe isn't composed/attached — callers steer blindly, that's fine. */
export type FoveaRectSeam = (pipeId: string, rect: Rect) => boolean;

/** Wave I-2 seams (all injected — the session stays core-free in vitest):
 *  the refcounted raw-pipe registry (recording), the pairing brick factory
 *  (trigger-mode L/R pairs; absent → pairing unwired), the compression brick
 *  (optional per-stream zlib), and the `recording:finished` notifier. */
export interface MultiFoveaSessionSeams {
  rawPipes: RawPipeRegistry;
  pair?: PairPipeSeam;
  compress?: CompressPipeSeam;
  /** stereo-paired-inputs (ruling 2): the paired-SGBM disparity brick. Composed
   *  over the `pair/undistort` stage when the trigger pairing topology is live
   *  (absent → no paired disparity node; free-run keeps the latest-wins node in
   *  disparity-scope). */
  stereo?: StereoPipeSeam;
  finished?: (foveaPath: string) => void;
}

export default function multiFoveaSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  setFoveaRect: FoveaRectSeam,
  seams: MultiFoveaSessionSeams,
): ServerSession<typeof multiFovea> {
  return defineResourceSession("multi-fovea", multiFovea, (s) => {
    let triple: CalibratedTriple | null = null;
    // Capture (ruling 3): degraded raw-stack capture over the leased triple.
    let captureHelper: CaptureHelper | null = null;
    let captureCenter: { shmName: string; maxBytes: number; channels: number } | null = null;
    let tk: MultiKcfTracker | null = null;
    let serialC: string | null = null;
    const trackMs = new RollingStats(0.9, 2, "ms");
    let lastTrackEmit = 0;
    let schedulerFrames = 0;
    let schedulerRejects = 0;
    let schedulerTimeouts = 0;

    const scheduler = new RoundRobinFrameScheduler({
      requester: {
        frame(request) {
          const controller = activeController();
          if (!controller) throw new Error("No controller connected");
          return controller.frame({
            ...request,
            pulse: request.pulse ?? s.state.pulse_ns,
            // Push the live settle hold into EVERY CMD_FRAME (per-triple seed +
            // drawer live-override). The firmware applies it only on a stream
            // SWITCH; 0 = no hold. Independent of pulse (not subtracted).
            settle_time: request.settle_time ?? s.state.settle_time_us,
          });
        },
      },
      onFrame(frame) {
        schedulerFrames++;
        runtime.onFrameFinished(frame.stream);
        s.telemetry({
          scheduler: {
            inFlight: scheduler.activeRequestCount,
            frames: schedulerFrames,
            rejects: schedulerRejects,
            timeouts: schedulerTimeouts,
          },
        });
      },
      onReject() {
        schedulerRejects++;
        publishScheduler();
      },
      onTimeout() {
        schedulerTimeouts++;
        publishScheduler();
      },
    });

    const runtime = new MultiFoveaRuntime(scheduler, {
      // Route to the CURRENT activation's tracker (the runtime is a session-
      // level singleton; `tk` swaps per activation).
      arm: (id, roi) => tk?.arm(id, roi),
      disarm: (id) => tk?.disarm(id),
      async createStream(index: number, center: Point2d): Promise<StreamHandle | null> {
        const controller = activeController();
        s.telemetry({ v2Capable: controller?.v2Capable ?? false });
        if (!controller?.v2Capable) return null;
        const pose = targetPose(index, center);
        return controller.createStream({ left: pose.volt.L, right: pose.volt.R });
      },
      targetPose: (index, center) => targetPose(index, center),
      projectAngle: (angle) => projectAngle(angle),
      updateScheduler(targets) {
        scheduler.setTargets(
          targets.map((target) => ({
            ...target,
            pulse: s.state.pulse_ns,
            cameras: ["L", "R"],
          })),
        );
        publishScheduler();
      },
      publish(targets) {
        const streams = activeController()?.streamSnapshot(1) ?? [];
        const hz = new Map(streams.map((stream) => [stream.id, stream.hz]));
        s.telemetry({
          targets: targets.map((target) => ({
            ...target,
            streamHz: target.streamId === null ? 0 : hz.get(target.streamId) ?? 0,
          })),
        });
        // Descriptor channels churn with target arm/disarm (recording ruling
        // 3) + the slot→controller-stream map the pair binding keys on.
        recording.onTargets(
          targets.map((t) => ({
            index: t.index,
            enabled: t.enabled,
            streamId: t.streamId,
          })),
        );
      },
      // Steer the slot's composed crop node — blind (false when the renderer
      // hasn't composed that fovea; the node follows as soon as it exists).
      updateFoveaRect(index, rect) {
        if (serialC) setFoveaRect(nodeId.fovea(serialC, index), rect);
      },
    });

    function publishScheduler(): void {
      s.telemetry({
        scheduler: {
          inFlight: scheduler.activeRequestCount,
          frames: schedulerFrames,
          rejects: schedulerRejects,
          timeouts: schedulerTimeouts,
        },
      });
    }

    /** Wide camera singleton metadata (multi-fovea-recording ruling 2) — the
     *  calibration triple's center intrinsics + distortion; null uncalibrated. */
    function wideCameraMeta(): Record<string, unknown> | null {
      const und = triple?.undistort;
      if (!und) return null;
      const cal = und.calibration;
      return {
        sensor_size: cal.sensor_size,
        camera_matrix: matToArray(cal.camera_matrix),
        dist_coeffs: matToArray(cal.dist_coeffs),
        focal: und.focal,
        center: und.center,
        fov: und.fov,
      };
    }

    // Multi-fovea RECORDING controller (multi-fovea-recording r2.1, wave I-2):
    // raw12p streams via the refcounted registry, optional per-stream zlib,
    // descriptor channels churned from the runtime's publish flow, extras from
    // matched pair anchors. Session-level singleton like manual-control's.
    const recording = createMultiFoveaRecording({
      cameras: () => {
        if (!triple) return null;
        const cam = (role: "L" | "C" | "R"): RecordingCamera => ({
          source: triple!.leases[role].camera,
          camera: triple!.leases[role].camera,
        });
        return { L: cam("L"), C: cam("C"), R: cam("R") };
      },
      wideCamera: wideCameraMeta,
      rawPipes: seams.rawPipes,
      connect: (pipeId) => {
        const handle = broker.connect(pipeId);
        return {
          shmName: handle.shmName,
          spec: handle.spec,
          release: () => void broker.disconnect(pipeId),
        };
      },
      compress: seams.compress,
      compressStreams: () => ({ ...s.state.record_compress }),
      finished: seams.finished ?? (() => {}),
      telemetry: (patch) => s.telemetry(patch),
    });

    function targetPose(
      index: number,
      center: Point2d,
    ): { angle: Point2d; volt: { L: Pos; R: Pos } } {
      // DEMO angle-space PRESET path: the mirror parks at the target's fixed
      // (pan, tilt) degrees. Both eyes point at the SAME angle (vergence at
      // infinity) through the EXISTING per-eye A2V mapping (the calibrate /
      // manual-control MEMS conversion — no new math). Uncalibrated → origin
      // volts, but the angle still surfaces in telemetry.
      const preset = s.state.targets[index]?.preset;
      if (preset) {
        const angle: Point2d = { x: radians(preset.pan), y: radians(preset.tilt) };
        if (!triple?.undistort) return { angle, volt: { L: ORIGIN, R: ORIGIN } };
        return {
          angle,
          volt: { L: triple.conv.A2V.L(angle), R: triple.conv.A2V.R(angle) },
        };
      }
      if (!triple?.undistort) {
        return { angle: { x: 0, y: 0 }, volt: { L: ORIGIN, R: ORIGIN } };
      }
      const angle = triple.undistort.angular([center], false)[0];
      const A = inverseTriangulate(angle, 200, 1000, radians(0));
      return {
        angle,
        volt: { L: triple.conv.A2V.L(A.l), R: triple.conv.A2V.R(A.r) },
      };
    }

    /** Project a mirror ANGLE (rad) to a wide-camera pixel for a preset's fovea
     *  crop placement — the inverse of the image-space `undistort.angular`.
     *  null when uncalibrated (the runtime falls back to the slot center). */
    function projectAngle(angle: Point2d): Point2d | null {
      return triple?.undistort ? triple.conv.A2P.C(angle, true) : null;
    }

    /** Consume the native batch stream (its own C++ thread) into the runtime's
     *  policy half. Ends when `tk.release()` closes the iterator on drain. */
    async function consumeTracker(t: MultiKcfTracker): Promise<void> {
      try {
        for await (const batch of t) {
          const elapsed = runtime.onTrackResults(batch);
          // Descriptor emission (recording ruling 3): every armed target's
          // observation in this batch → one `fovea/<slot>` doc. No-op idle.
          recording.onTrackBatch(batch);
          if (elapsed <= 0) continue;
          trackMs.push(elapsed);
          const now = performance.now();
          if (now - lastTrackEmit >= 1000) {
            lastTrackEmit = now;
            s.telemetry({ perf: { trackMs: { mean: trackMs.mean, max: trackMs.max } } });
            trackMs.resetMax();
          }
        }
      } catch {
        /* iterator closed by release() on drain — expected */
      }
    }

    /** Consume the ROOT pair brick's batched records (FIN rate — low, loop-
     *  safe): forward each as a RESOLVED anchor to the downstream exact brick
     *  (pairing-nodes ruling 2 / R-1) and into the recording controller
     *  (descriptor L/R re-keying + extras anchors). Ends when the brick is
     *  released on drain. */
    async function consumePairs(
      root: PairHandle,
      downstream: PairHandle | null,
    ): Promise<void> {
      try {
        for await (const batch of root)
          for (const rec of batch.records) {
            downstream?.pushResolvedAnchor(resolvedAnchorFromRecord(rec));
            recording.onPairRecord(rec);
          }
      } catch {
        /* iterator closed by release() on drain — expected */
      }
    }

    function applyTargets(): void {
      runtime.setTargets(s.state.targets.slice(0, MAX_MULTI_FOVEA_TARGETS));
    }

    function updateTarget(
      index: number,
      update: (
        target: (typeof s.state.targets)[number],
      ) => (typeof s.state.targets)[number],
    ): void {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= MAX_MULTI_FOVEA_TARGETS
      )
        return;
      const next = s.state.targets.slice(0, MAX_MULTI_FOVEA_TARGETS);
      const current = next[index] ?? defaultMultiFoveaTarget(index);
      next[index] = update(current);
      s.setState("targets", next);
      applyTargets();
    }

    // Resource-scoped activation (A-P1). `scheduler`/`runtime` are session-level
    // singletons; per activation we lease the triple + spin the multi-KCF
    // thread, and the drain releases the tracker (closing its iterator) +
    // stops the scheduler + disposes the runtime. Lease releases LAST.
    async function activateSession(scope: ResourceScope): Promise<void> {
      // Spin-up progress (ruling 2026-07-09): declare the activation steps
      // upfront so the window shows this sequence instead of blanking while the
      // graph builds. A failure/early-return path leaves the list FROZEN at the
      // step it died on (never `done`/`complete`) — the error surfaces
      // separately; the scope's idle teardown clears it on a cancelled spin-up.
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing cameras" },
        { id: "calibration", label: "Loading calibration" },
        { id: "pipes", label: "Building fovea pipes" },
        { id: "trackers", label: "Starting trackers" },
        { id: "controller", label: "Wiring controller" },
      ]);
      monitor.start("lease");
      const t = await scope.use(() => acquireTriple(s), releaseLeases);
      if (!t) return; // frozen at "Leasing cameras" — honest (contention/fail)
      monitor.done("lease");
      triple = t;
      serialC = t.leases.C.camera.serial;
      // Seed the live settle hold from the ACTIVE triple's per-triple config
      // (per-triple ruling). The drawer slider overrides this LIVE for the
      // running session (same orchestrator instance). A Settings-page edit is
      // picked up at the NEXT activation only — config-store docs are
      // per-instance, so a cross-instance live push is intentionally out of
      // scope (known gotcha); starting a fresh session re-reads it here.
      s.setState("settle_time_us", t.settleTimeUs);
      scope.defer(() => {
        triple = null;
        serialC = null;
      });
      scope.defer(() => runtime.dispose());
      scope.defer(() => scheduler.stop());
      // Best-effort: a FORCED drain mid-recording (busy() normally refuses the
      // switch) still finalizes the container before the leases release.
      scope.defer(() => {
        if (recording.active) void recording.stop();
      });
      // real-1g (C-23): advertise the first-class `undistort:<serial>` center
      // pipe — the renderer binds it directly for the wide view.
      monitor.start("calibration");
      let undistortC: string | null = null;
      if (t.undistort) {
        undistortC = advertiseUndistortPipe(
          undistortSeam,
          t.leases.C.camera,
          t.undistort.calibration,
        );
        s.setState("undistortPipe", undistortC);
        scope.defer(() => {
          retireUndistortPipe(undistortSeam, undistortC!);
          s.setState("undistortPipe", null);
        });
      }

      monitor.done("calibration");

      // Unified-topology §5: L/R mirror-steered HOMOGRAPHY undistort bricks,
      // chained on the shared converters + fed H(mirrorAt(t)) at ~200 Hz
      // (the same wiring the other steered sessions use — see homography-feeder
      // for the v1 A2H∘V2A derivation + its open direction question). The renderer-
      // composed fovea crop slots chain on the CENTER camera's intrinsic
      // undistort (advertised above) when calibrated, else its converter —
      // `createFoveaMaterializer` resolves that per camera.
      monitor.start("pipes");
      const computeH = conversionComputeH(t.conv);
      const undistortIds: Partial<Record<"L" | "R", string>> = {};
      for (const side of ["L", "R"] as const) {
        const pipeId = advertiseHomographyUndistortPipe(
          undistortSeam,
          t.leases[side].camera,
        );
        undistortIds[side] = pipeId;
        const stopFeeder = startHomographyFeeder({
          pipeId,
          side,
          computeH,
          push: pushHomography,
        });
        scope.defer(() => {
          stopFeeder(); // stop pushing BEFORE the brick detaches
          retireUndistortPipe(undistortSeam, pipeId);
        });
      }

      // --- pairing wiring (pairing-nodes, wave I-2) -------------------------
      // ALWAYS-RUNNING with the trigger topology (ruling 5): the ROOT pair
      // brick joins the L/R CONVERT taps against FIN anchors (tolerance-match
      // ONCE, ruling 2); the DOWNSTREAM exact brick joins the two homography-
      // undistort outputs on the carried deviceTimestamps, fed RESOLVED
      // anchors from the root's records (R-1 key delivery). Trigger mode ONLY
      // (ruling 1): in free-run the pool is empty and both bricks idle;
      // recording still works (descriptors without pair provenance).
      if (seams.pair) {
        try {
          const root = seams.pair(
            nodeId.convert(t.leases.L.camera.serial),
            nodeId.convert(t.leases.R.camera.serial),
            { mode: "root", stage: "pair/convert", anchorFrom: anchorNodeId() },
          );
          scope.defer(() => root.release());
          // Downstream exact-stage pair — wired only while the undistort
          // bricks are live (they are advertised just above; guard anyway).
          let downstream: PairHandle | null = null;
          if (undistortIds.L && undistortIds.R) {
            downstream = seams.pair(undistortIds.L, undistortIds.R, {
              mode: "exact",
              stage: "pair/undistort",
              anchorFrom: "pair/convert",
            });
            scope.defer(() => downstream!.release());
            // stereo-paired-inputs (ruling 1/2): the paired-SGBM disparity node,
            // composed over the `pair/undistort` stage with the trigger pairing
            // topology (RECOMPOSE-on-trigger, at the granularity the runtime
            // exposes — the pairing topology is the trigger topology). ON-DEMAND
            // (ruling 5): parked with no consumer, it taps nothing; the pair
            // brick's keep-alive is unaffected. Output advert + timestamps are
            // identical to the free-run latest-wins node (ruling 4). Degrades
            // silently if the seam is absent (vitest / no-stereo builds).
            if (seams.stereo) {
              const camL = t.leases.L.camera;
              let stereo: StereoHandle | null = createPairedStereoPipe(
                seams.stereo,
                "pair/undistort",
                nodeId.stereo("paired"),
                {
                  maxWidth: camL.getFeatureInt("Width"),
                  maxHeight: camL.getFeatureInt("Height"),
                },
              );
              scope.defer(() => {
                stereo?.retire();
                stereo = null;
              });
            }
          }
          // ONE enrichment source (ruling 4): conversions bound per activation
          // (volts→angle→H attachments); the controller's FIN outcomes fan in.
          const an = anchorNode();
          an.setConversions(t.conv);
          scope.defer(() => an.setConversions(undefined));
          scope.defer(an.register(root));
          scope.defer(controllerNode().onFin((outcome) => an.ingest(outcome)));
          scope.defer(
            registerNativeProbe((): Record<string, WorkloadSnapshot> => {
              const probes: Record<string, WorkloadSnapshot> = {
                [root.id]: root.probe(),
              };
              if (downstream) probes[downstream.id] = downstream.probe();
              return probes;
            }),
          );
          void consumePairs(root, downstream);
        } catch (e) {
          // A missing source brick (e.g. converters not live on this rig
          // shape) degrades to unpaired recording — never fails activation.
          console.warn("[multi-fovea] pairing wiring unavailable:", e);
        }
      }
      monitor.done("pipes");

      // B-25: the multi-target KCF thread, bound to the shared center stream,
      // batched results OFF the JS loop; fused undistort when calibrated (so
      // bboxes land in the same undistorted space targetPose expects). Probe
      // key = node id (B-24 convention) → folds into the topology for free.
      monitor.start("trackers");
      tk = createMultiTracker(t.leases.C.camera, {
        cal: t.undistort?.calibration,
        name: nodeId.kcfMulti(serialC),
      });
      scope.defer(() => {
        tk?.release(); // closes the iterator; consumeTracker returns
        tk = null;
      });
      scope.defer(
        registerNativeProbe(
          (): Record<string, WorkloadSnapshot> =>
            tk && serialC
              ? { [nodeId.kcfMulti(serialC)]: multiWorkload(tk.probe()) }
              : {},
        ),
      );
      void consumeTracker(tk);
      monitor.done("trackers");

      monitor.start("controller");
      // Arm-rect clamp source (ruled): camera dims from the lease at activate.
      runtime.setFrameSize({
        width: t.leases.C.camera.getFeatureInt("Width"),
        height: t.leases.C.camera.getFeatureInt("Height"),
      });
      publishSerials(t.leases, scope, s);
      // Run the round-robin frame scheduler for this activation (paired with the
      // `scheduler.stop()` drain above). Without this the scheduler's `running`
      // flag never flips and `pump()` early-returns, so no CMD_FRAME is ever
      // issued once v2 hardware lands. Inert on the current rig: `createStream`
      // returns null when !v2Capable → empty targets → pump has nothing to issue.
      scheduler.start();
      applyTargets();

      // --- capture (ruling 3) ------------------------------------------------
      // Stacked L/R + center-slice capture over the leased triple (distinct from
      // `captureOnce`, the stage-f hardware-synchronized MEMS shot). Degraded
      // shot (`rawTripleShot`): no per-shot mirror pose → no fovea wrap. Center
      // rides the undistort pipe (or convert fallback) connected here.
      const capCenterId = undistortC ?? nodeId.convert(serialC);
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
        id: nodeId.win("multi-fovea", "capture"),
        broker,
        rawPipes: seams.rawPipes,
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
                note: "multi-fovea: raw stacks, no per-shot mirror pose (no wrap)",
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

      s.telemetry({
        ready: true,
        v2Capable: activeController()?.v2Capable ?? false,
        captureRejected: "stage-f-hardware-gated",
      });
      monitor.done("controller");
      monitor.complete(); // spin-up finished — clear the overlay
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        s.resetTelemetry(["ready", "v2Capable"]);
      },
      commands: {
        async setTargetEnabled({ index, enabled }) {
          updateTarget(index, (target) => ({ ...target, enabled }));
        },
        async steerTarget({ index, center }) {
          runtime.steerTarget(index, center);
        },
        async placeTarget({ index, center }) {
          // Placing an image-space point CLEARS any preset (KCF resumes).
          updateTarget(index, (target) => ({ ...target, center, preset: null }));
        },
        async placePreset({ index, pan, tilt }) {
          // Angle-space DEMO path: mark the target a fixed mirror-angle preset;
          // the runtime parks it there (no KCF) and the round-robin interleaves
          // it. Enabling it so an edit is immediately live. Clamped HERE (not
          // just the UI) so no caller can over-drive the mirror — A2V has no
          // domain guard and the DAC assert throws (rig-safety, UI/UX review
          // 2026-07-10).
          updateTarget(index, (target) => ({
            ...target,
            enabled: true,
            preset: { pan: clampPresetAngle(pan), tilt: clampPresetAngle(tilt) },
          }));
        },
        async resetTargets() {
          // Reset to the DEMO preset pair (±5°) — the app's default shape.
          s.setState("targets", [0, 1, 2, 3].map(demoPresetTarget));
          applyTargets();
        },
        async captureOnce() {
          const controller = activeController();
          if (!controller)
            return { ok: false, reason: "controller-not-connected" };
          if (!controller.v2Capable)
            return { ok: false, reason: "controller-not-v2-capable" };
          return { ok: false, reason: "stage-f-hardware-gated" };
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
        targets: () => applyTargets(),
        pulse_ns: () => applyTargets(),
      },
      busy() {
        // Drain refusal (manual-control pattern): the multi-window switch path
        // must not force-drain mid-recording or mid-capture.
        if (captureHelper?.capturing) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}

/** Adapt the native meter to the `WorkloadSnapshot` shape (the same adapter
 *  the disparity tracker uses, one thread for N targets). */
function multiWorkload(m: Tracker.TrackerMeter): WorkloadSnapshot {
  const t = Date.now();
  return {
    name: m.name,
    window: { startedAt: t - m.uptimeMs, snapshotAt: t, uptimeMs: m.uptimeMs },
    utilization: m.utilization,
    busyMs: m.busyMs,
    inputs: m.inputs,
    outputs: m.outputs,
    drops: { total: m.dropTotal, ratePerSec: 0, byReason: {} },
  };
}
