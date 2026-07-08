// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { activeController, type StreamHandle } from "@orchestrator/controller";
import { RoundRobinFrameScheduler } from "@orchestrator/scheduler";
import { publishSerials, releaseLeases } from "@orchestrator/session-resources";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import type { DisplayValues } from "@orchestrator/display-transport";
import {
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import { multiFovea, defaultMultiFoveaTarget, MAX_MULTI_FOVEA_TARGETS } from "./contract";
import { MultiFoveaRuntime } from "./runtime";
import { KCF } from "core/Tracker";
import { makeMat } from "@lib/mat";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { inverseTriangulate } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";

const ORIGIN: Pos = { x: 0, y: 0 };

function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export default function multiFoveaSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
): ServerSession<typeof multiFovea> {
  return defineResourceSession("multi-fovea", multiFovea, (s) => {
    let triple: CalibratedTriple | null = null;
    let worker: VisionWorkerHandle | null = null;
    const trackMs = new RollingStats(0.9, 2, "ms");
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
      createTracker: () => new KCF(),
      async createStream(_index: number, center: Point2d): Promise<StreamHandle | null> {
        const controller = activeController();
        s.telemetry({ v2Capable: controller?.v2Capable ?? false });
        if (!controller?.v2Capable) return null;
        const pose = targetPose(center);
        return controller.createStream({ left: pose.volt.L, right: pose.volt.R });
      },
      targetPose: (_index, center) => targetPose(center),
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

    function targetPose(center: Point2d): { angle: Point2d; volt: { L: Pos; R: Pos } } {
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

    // C-22b step 3: the center undistort moved to the `display` vision worker
    // (off the JS event loop) — the worker posts the undistorted "C" frame, and
    // this consumes it exactly as the old `onCenterView` did. The multi-target
    // KCF (`runtime.onCenterFrame`) still runs on the main loop for now; moving
    // it to a dedicated C++ thread is the separate async-kcf refactor.
    function onResult(r: VisionResult): void {
      void (r.values as DisplayValues);
      for (const f of r.frames) {
        if (f.name !== "C") continue;
        const view = makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels);
        s.frame("C", view);
        void (async () => {
          const elapsed = await runtime.onCenterFrame(view);
          if (!triple || elapsed <= 0) return;
          trackMs.push(elapsed);
          s.telemetry({
            size: { width: view.shape[1], height: view.shape[0] },
            perf: { trackMs: { mean: trackMs.mean, max: trackMs.max } },
          });
          trackMs.resetMax();
        })();
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
    // singletons; per activation we lease the triple + tap the center view, and
    // the drain stops the scheduler + disposes the runtime (re-populated by
    // `applyTargets` on the next activate, as before). Lease releases LAST.
    async function activateSession(scope: ResourceScope): Promise<void> {
      const t = await scope.use(() => acquireTriple(s), releaseLeases);
      if (!t) return;
      triple = t;
      scope.defer(() => {
        triple = null;
      });
      scope.defer(() => runtime.dispose());
      scope.defer(() => scheduler.stop());
      // real-1g (C-23): advertise the first-class `undistort:<serial>` center
      // pipe. The renderer binds it directly for the wide view; the worker here
      // is the ruled Q1(a) MINIMAL RELAY — it reads the same pipe and posts
      // frames solely for the on-main KCF (`runtime.onCenterFrame`), dying
      // naturally when async-kcf→C++ lands. Retire defer registered BEFORE the
      // worker's → runs after the consumers disconnect (LIFO).
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
      // Connect the center pipe (C-21 gate) + spawn the relay worker. Its
      // teardown is registered LAST → drains FIRST: the worker terminates
      // (stopping frames) before the runtime disposes, exactly as the old
      // center-view tap did. Uncalibrated rigs fall back to the raw pipe.
      const cId = undistortC ?? nodeId.convert(t.leases.C.camera.serial);
      const handle = broker.connect(cId);
      const cPipe: PipeInput = {
        role: "C",
        shmName: handle.shmName,
        width: handle.spec.width,
        height: handle.spec.height,
        channels: handle.spec.channels,
        bytesPerFrame: handle.spec.maxBytes ?? handle.spec.bytesPerFrame,
      };
      worker = createVisionWorker(
        {
          pipes: [cPipe],
          params: {
            kind: "display",
            view: "diff", // non-"sliced" → no slice output; relayCenter is the point
            relayCenter: true, // Q1(a): post "C" for the on-main multi-target KCF
          },
        },
        onResult,
      );
      publishSerials(t.leases, scope, s);
      scope.defer(() => {
        worker?.terminate();
        worker = null;
        broker.disconnect(cId);
      });
      // Run the round-robin frame scheduler for this activation (paired with the
      // `scheduler.stop()` drain above). Without this the scheduler's `running`
      // flag never flips and `pump()` early-returns, so no CMD_FRAME is ever
      // issued once v2 hardware lands. Inert on the current rig: `createStream`
      // returns null when !v2Capable → empty targets → pump has nothing to issue.
      scheduler.start();
      applyTargets();
      s.telemetry({
        ready: true,
        v2Capable: activeController()?.v2Capable ?? false,
        captureRejected: "stage-f-hardware-gated",
      });
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
          updateTarget(index, (target) => ({ ...target, center }));
        },
        async resetTargets() {
          s.setState(
            "targets",
            [0, 1, 2, 3].map(defaultMultiFoveaTarget),
          );
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
      },
      watch: {
        targets: () => applyTargets(),
        pulse_ns: () => applyTargets(),
      },
    };
  });
}
