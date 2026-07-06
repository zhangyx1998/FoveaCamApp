// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { leaseCalibratedTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { activeController, type StreamHandle } from "@orchestrator/controller";
import { RoundRobinFrameScheduler } from "@orchestrator/scheduler";
import { multiFovea, defaultMultiFoveaTarget, MAX_MULTI_FOVEA_TARGETS } from "./contract";
import { MultiFoveaRuntime } from "./runtime";
import { KCF } from "core/Tracker";
import type { Point2d } from "core/Geometry";
import type { Mat } from "core/Vision";
import type { Pos } from "@lib/controller-codec";
import { inverseTriangulate } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";

const ORIGIN: Pos = { x: 0, y: 0 };

function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export default function multiFoveaSession(): ServerSession<typeof multiFovea> {
  return defineSession("multi-fovea", multiFovea, (s) => {
    let triple: CalibratedTriple | null = null;
    const disposers: Array<() => void> = [];
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

    function onCenterView(raw: Mat<Uint8Array>): void {
      const view = triple?.undistort ? triple.undistort.apply(raw) : raw;
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

    async function activateSession(): Promise<void> {
      const t = await leaseCalibratedTriple();
      if (!t) {
        s.telemetry({ ready: false });
        return;
      }
      triple = t;
      disposers.push(t.leases.C.onView(onCenterView));
      applyTargets();
      s.telemetry({
        ready: true,
        v2Capable: activeController()?.v2Capable ?? false,
        captureRejected: "stage-f-hardware-gated",
      });
    }

    function idleSession(): void {
      scheduler.stop();
      runtime.dispose();
      for (const d of disposers) d();
      disposers.length = 0;
      if (triple) for (const l of Object.values(triple.leases)) l.release();
      triple = null;
      s.telemetry({ ready: false, v2Capable: false });
    }

    return {
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
      activate() {
        void activateSession();
      },
      idle: idleSession,
    };
  });
}
