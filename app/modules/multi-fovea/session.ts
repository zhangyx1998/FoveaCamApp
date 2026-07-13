// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Multi-fovea session — N interleaved foveas over one shared center stream, a
// thin coordinator over the native multi-KCF thread + the `MultiFoveaRuntime`
// policy half. Behavior spec: docs/spec/multi-fovea.md.

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
import { mirrorHistory } from "@orchestrator/mirror-history";
import { pushHomography } from "core/Aravis";
import { registerNativeProbe } from "@orchestrator/native-probes";
import { registerGraphWiring } from "@orchestrator/graph-topology";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";
import type { RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import type { PairPipeSeam, PairHandle } from "@orchestrator/pair-pipe";
import {
  createPairedStereoPipe,
  SIGNED_DISPARITY_WINDOW,
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
import { pairTriggerBudget, type PairTriggerBudget } from "@lib/camera-config";
import { cameraConfigPath } from "@orchestrator/camera";
import { subscribe } from "@orchestrator/store-hub";
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

/** Convergence distance for the center-steer toe-in (mm). A fixed, deliberate
 *  mid-range default — the steer targets a wide-view pixel, not a measured
 *  depth (calibration review 2026-07-11 #16 named the old inline literal). */
const CENTER_STEER_CONVERGE_MM = 1000;

function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Native multi-KCF surface (d.ts pending; cast like the Aravis NAPIs). `arm`
 *  on a live id RE-INITS that target (ruled steer-while-armed). */
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

/** Injected seams (keep the session core-free in vitest): the raw-pipe registry
 *  (recording), the pairing brick factory, the compression brick, and the
 *  `recording:finished` notifier. See spec §pairing, §recording. */
export interface MultiFoveaSessionSeams {
  rawPipes: RawPipeRegistry;
  pair?: PairPipeSeam;
  compress?: CompressPipeSeam;
  /** The paired-SGBM disparity brick over the `pair/undistort` stage (spec
   *  §pairing); absent → no paired disparity node. */
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
    // Capture: degraded raw-stack capture over the leased triple (spec §capture).
    let captureHelper: CaptureHelper | null = null;
    let captureCenter: { shmName: string; maxBytes: number; channels: number } | null = null;
    let tk: MultiKcfTracker | null = null;
    let serialC: string | null = null;
    // Exposure-derived trigger budget (P6) — the scheduler's per-target pacing
    // floor; null until a triple is leased. See `deriveBudget`.
    let budget: PairTriggerBudget | null = null;
    const trackMs = new RollingStats(0.9, 2, "ms");
    let lastTrackEmit = 0;
    let schedulerFrames = 0;
    let schedulerRejects = 0;
    let schedulerTimeouts = 0;

    const scheduler = new RoundRobinFrameScheduler({
      // FIN budget follows the live pulse-derived interval (getter — this
      // scheduler outlives any single budget): a long exposure must not
      // FIN-time-out under a fixed 1 s and wedge (spec §trigger-sync).
      completionTimeoutMs: () => Math.max(1000, (budget?.minIntervalMs ?? 0) * 3),
      requester: {
        frame(request) {
          const controller = activeController();
          if (!controller) throw new Error("No controller connected");
          return controller.frame({
            ...request,
            // Explicit L|R mask — an absent mask is NAPI-encoded 0, not the
            // documented CAM_L|CAM_R default.
            cameras: ["L", "R"],
            // `pulse_ns` is the persist/display unit; the wire (`FrameArg.pulse`)
            // is µs (spec §trigger-sync).
            pulse: request.pulse ?? Math.round(s.state.pulse_ns / 1000),
            settle_time: request.settle_time ?? s.state.settle_time_us, // spec §settle
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
            // Wire unit is µs; `pulse_ns` is the persist/display ns (spec §trigger-sync).
            pulse: Math.round(s.state.pulse_ns / 1000),
            cameras: ["L", "R"],
            // Exposure-derived pacing (P6): never trigger a pair faster than
            // it can expose + read out. Undefined pre-lease → scheduler default.
            minIntervalMs: budget?.minIntervalMs,
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
        // Descriptor channels + the slot→stream map churn with arm/disarm (spec §recording).
        recording.onTargets(
          targets.map((t) => ({
            index: t.index,
            enabled: t.enabled,
            streamId: t.streamId,
          })),
        );
      },
      // Steer the slot's composed crop node — blind (false while the renderer
      // hasn't composed that fovea; it follows once the node exists).
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

    /** Wide camera singleton metadata (spec §recording) — the triple's center
     *  intrinsics + distortion (+ per-triple baseline_mm); null uncalibrated. */
    function wideCameraMeta(): Record<string, unknown> | null {
      const und = triple?.undistort;
      if (!und) return null;
      const cal = und.calibration;
      const meta: Record<string, unknown> = {
        sensor_size: cal.sensor_size,
        camera_matrix: matToArray(cal.camera_matrix),
        dist_coeffs: matToArray(cal.dist_coeffs),
        focal: und.focal,
        center: und.center,
        fov: und.fov,
      };
      // Per-triple baseline (mm) rides alongside the intrinsics for Part B's
      // depth readout (additive; old containers → viewer shows "—").
      if (triple?.baselineMm != null) meta.baseline_mm = triple.baselineMm;
      return meta;
    }

    // Multi-fovea RECORDING controller (spec §recording) — session-level singleton.
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
      // Free-run extras (spec §recording): the actuation history at each frame's
      // exposure host-ns + the active triple's conversions (null uncalibrated).
      mirrorAt: (hostNs) => mirrorHistory.mirrorAt(hostNs),
      conversions: () => triple?.conv ?? null,
      finished: seams.finished ?? (() => {}),
      telemetry: (patch) => s.telemetry(patch),
    });

    function targetPose(
      index: number,
      center: Point2d,
    ): { angle: Point2d; volt: { L: Pos; R: Pos } } {
      // Angle-space PRESET path (spec §targets): park at the fixed (pan, tilt);
      // both eyes at the same angle through the per-eye A2V. Uncalibrated →
      // origin volts, angle still surfaces in telemetry.
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
      // Per-triple PHYSICAL baseline (review #16 — was a hardcoded 200 mm);
      // 200 stays as the no-stored-baseline fallback (the app-wide default).
      const A = inverseTriangulate(
        angle,
        triple.baselineMm ?? 200,
        CENTER_STEER_CONVERGE_MM,
        radians(0),
      );
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

    /** Consume the ROOT pair brick's batched records (FIN rate): forward each as
     *  a RESOLVED anchor to the downstream exact brick + into the recording
     *  controller (spec §pairing, §recording). Ends on drain release. */
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

    /** Derive the trigger budget from the leased pair's CONFIGURED exposure
     *  (P6 ruled default: exposure config is authoritative; the pulse and the
     *  scheduler pacing follow it). The AUTHORITY FLIP POINT lives inside
     *  `pairTriggerBudget` (@lib/camera-config) — this is its only multi-fovea
     *  call site. Re-run on activate, on a settle edit, and whenever either
     *  fovea's config doc changes (manage-cameras edits are observable through
     *  the store; the shared registry lease means the live handle already
     *  carries the new value). */
    function deriveBudget(): void {
      if (!triple) return;
      const safe = <T,>(fn: () => T, fallback: T): T => {
        try {
          return fn();
        } catch {
          return fallback;
        }
      };
      const camL = triple.leases.L.camera;
      const camR = triple.leases.R.camera;
      const exposureUsL = safe(() => camL.exposure, 0);
      const exposureUsR = safe(() => camR.exposure, 0);
      budget = pairTriggerBudget({
        exposureUsL,
        exposureUsR,
        settleUs: s.state.settle_time_us,
        maxRateHzL: safe(() => camL.frame_rate_range.max, 0),
        maxRateHzR: safe(() => camR.frame_rate_range.max, 0),
      });
      s.telemetry({
        budget: { ...budget, exposureUsL, exposureUsR, settleUs: s.state.settle_time_us },
      });
      // Server-side setState does NOT fire the state watchers, so this never
      // trips the pulse_ns watch's manual-override latch. The state key persists
      // ns (display); the budget is µs — scale up at this boundary.
      if (s.state.pulse_auto) s.setState("pulse_ns", budget.pulseUs * 1000);
      applyTargets(); // re-push pulse + minIntervalMs into the scheduler
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

    // Resource-scoped activation (spec §topology): lease + spin the multi-KCF
    // thread; the drain releases tracker → scheduler → runtime, lease LAST.
    async function activateSession(scope: ResourceScope): Promise<void> {
      // Progress monitor: an early-return leaves the list FROZEN at its step;
      // the scope's idle teardown clears it.
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
      // Seed the live settle hold from the active triple; the drawer overrides it
      // live, a Settings edit applies next activation only (spec §settle).
      s.setState("settle_time_us", t.settleTimeUs);
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
      scope.defer(() => {
        triple = null;
        serialC = null;
        budget = null;
      });
      // Re-derive the trigger budget on either fovea's config-doc change
      // (manage-cameras edits are observable via the store broadcast; the
      // shared registry lease means the live camera already holds the value).
      for (const side of ["L", "R"] as const)
        scope.defer(
          subscribe(cameraConfigPath(t.leases[side].camera), () => deriveBudget()),
        );
      scope.defer(() => runtime.dispose());
      scope.defer(() => scheduler.stop());
      // Best-effort: a FORCED drain mid-recording (busy() normally refuses the
      // switch) still finalizes the container before the leases release.
      scope.defer(() => {
        if (recording.active) void recording.stop();
      });
      // Advertise the center `undistort:<serial>` pipe (renderer binds the wide view).
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

      // L/R mirror-steered HOMOGRAPHY undistort bricks, fed H(mirrorAt(t)) at
      // ~200 Hz (spec §topology). The renderer-composed fovea slots chain on the
      // center's intrinsic undistort (or its converter, uncalibrated).
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

      // --- pairing wiring (spec §pairing) -----------------------------------
      // Root brick joins the L/R convert taps against FIN anchors; the downstream
      // exact brick joins the undistort outputs on the resolved anchors. Active
      // in trigger mode only (free-run idles; recording still works).
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
            // The paired-SGBM disparity node over the `pair/undistort` stage,
            // ON-DEMAND (parked with no consumer; spec §pairing). Degrades
            // silently if the seam is absent.
            if (seams.stereo) {
              const camL = t.leases.L.camera;
              let stereo: StereoHandle | null = createPairedStereoPipe(
                seams.stereo,
                "pair/undistort",
                nodeId.stereo("paired"),
                {
                  maxWidth: camL.getFeatureInt("Width"),
                  maxHeight: camL.getFeatureInt("Height"),
                  // Fixed symmetric −256…+255 window (sgbm-signed-range.md;
                  // foveated gaze makes disparity SIGNED).
                  params: SIGNED_DISPARITY_WINDOW,
                },
              );
              scope.defer(() => {
                stereo?.retire();
                stereo = null;
              });
            }
          }
          // ONE enrichment source (spec §pairing): conversions per activation;
          // the controller's FIN outcomes fan in.
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
          // A missing source brick degrades to unpaired recording (spec §pairing).
          console.warn("[multi-fovea] pairing wiring unavailable:", e);
        }
      }
      monitor.done("pipes");

      // The multi-target KCF thread on the shared center stream, batched OFF the
      // JS loop; fused undistort when calibrated. Probe key = node id.
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
      // Exposure-derived pulse + pacing (P6) — before the scheduler starts so
      // the first CMD_FRAMEs already carry the derived values.
      deriveBudget();
      // Start the round-robin scheduler (spec §topology): must run or `pump()`
      // early-returns; inert on the current rig (empty targets while !v2Capable).
      scheduler.start();
      applyTargets();

      // --- capture (spec §capture) -------------------------------------------
      // Degraded raw-stack capture over the leased triple; center rides the
      // undistort pipe (or convert fallback) connected here.
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
        s.resetTelemetry(["ready", "v2Capable", "budget"]);
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
          // Mark the target a fixed mirror-angle preset (spec §targets); enable
          // it so an edit is live. Clamped HERE, not just the UI (rig-safety).
          updateTarget(index, (target) => ({
            ...target,
            enabled: true,
            preset: { pan: clampPresetAngle(pan), tilt: clampPresetAngle(tilt) },
          }));
        },
        async resetTargets() {
          // Reset to the demo preset pair (±5°) — the app's default shape.
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
        pulse_ns: () => {
          // A client write (the Pulse slider) takes MANUAL override: stop
          // deriving until pulse_auto is turned back on. The session's own
          // derived setState bypasses watchers, so it never lands here.
          if (s.state.pulse_auto) s.setState("pulse_auto", false);
          applyTargets();
        },
        pulse_auto: (on) => {
          if (on) deriveBudget();
        },
        settle_time_us: () => deriveBudget(),
      },
      busy() {
        // Drain refusal: never force-drain mid-recording or mid-capture.
        if (captureHelper?.capturing) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}

/** Adapt the native meter to the `WorkloadSnapshot` shape (one thread, N targets). */
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
