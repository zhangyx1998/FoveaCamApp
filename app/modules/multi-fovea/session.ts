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
import { multiFovea, defaultMultiFoveaTarget, MAX_MULTI_FOVEA_TARGETS } from "./contract";
import { MultiFoveaRuntime, type MultiTrackBatch } from "./runtime";
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

export default function multiFoveaSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  setFoveaRect: FoveaRectSeam,
): ServerSession<typeof multiFovea> {
  return defineResourceSession("multi-fovea", multiFovea, (s) => {
    let triple: CalibratedTriple | null = null;
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

    /** Consume the native batch stream (its own C++ thread) into the runtime's
     *  policy half. Ends when `tk.release()` closes the iterator on drain. */
    async function consumeTracker(t: MultiKcfTracker): Promise<void> {
      try {
        for await (const batch of t) {
          const elapsed = runtime.onTrackResults(batch);
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
      const t = await scope.use(() => acquireTriple(s), releaseLeases);
      if (!t) return;
      triple = t;
      serialC = t.leases.C.camera.serial;
      scope.defer(() => {
        triple = null;
        serialC = null;
      });
      scope.defer(() => runtime.dispose());
      scope.defer(() => scheduler.stop());
      // real-1g (C-23): advertise the first-class `undistort:<serial>` center
      // pipe — the renderer binds it directly for the wide view.
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

      // Unified-topology §5: L/R mirror-steered HOMOGRAPHY undistort bricks,
      // chained on the shared converters + fed H(mirrorAt(t)) at ~200 Hz
      // (same wiring as tracking-single — see homography-feeder for the v1
      // A2H∘V2A derivation + its open direction question). The renderer-
      // composed fovea crop slots chain on the CENTER camera's intrinsic
      // undistort (advertised above) when calibrated, else its converter —
      // `createFoveaMaterializer` resolves that per camera.
      const computeH = conversionComputeH(t.conv);
      for (const side of ["L", "R"] as const) {
        const pipeId = advertiseHomographyUndistortPipe(
          undistortSeam,
          t.leases[side].camera,
        );
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
      // B-25: the multi-target KCF thread, bound to the shared center stream,
      // batched results OFF the JS loop; fused undistort when calibrated (so
      // bboxes land in the same undistorted space targetPose expects). Probe
      // key = node id (B-24 convention) → folds into the topology for free.
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

/** Adapt the native meter to the `WorkloadSnapshot` shape (same as
 *  tracking-single's `trackerWorkload`, one thread for N targets). */
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
