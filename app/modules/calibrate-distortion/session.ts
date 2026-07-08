// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-distortion session (docs/history/refactor/orchestrator.md §7.1 S1b):
// projector-alignment/homography validation. Three `MarkerTracker`s (L/R with
// subpixel `internal` refinement); the center tracker's observed angle
// continuously points both mirrors there (via `startActuationLoop`).
//
// C-22b step 3: the per-fovea projection warp moved OFF the JS event loop. The
// marker trackers run on their own native streams; on each fovea detection main
// computes the projection homography (a cheap 4-point `findHomography`) and
// ships it to the `distortion` vision worker, which reads the fovea pipe and
// does the heavy `wrapPerspective`, posting the raw preview + warped overlay.
// The registry `onView` tap is gone.

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { findHomography } from "core/Vision";
import { area, type Point2d } from "core/Geometry";
import { type MarkerTracker } from "@orchestrator/marker-tracker";
import { publishSerials, DisposerBag, releaseLeases } from "@orchestrator/session-resources";
import { detectionViews, retarget } from "@orchestrator/marker-calibration";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeBroker } from "@orchestrator/pipe-session";
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

export default function calibrateDistortionSession(broker: PipeBroker): ServerSession<typeof calibrateDistortion> {
  return defineResourceSession("calibrate-distortion", calibrateDistortion, (s) => {
    let triple: CalibratedTriple | null = null;
    let trackers: Record<Role, MarkerTracker> | null = null;
    let loop: ActuationLoop | null = null;
    let worker: VisionWorkerHandle | null = null;
    let centerAngle: Point2d | null = null;
    const projBusy: Record<"L" | "R", boolean> = { L: false, R: false };

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
      publishDetections();
    }

    // Compute the projection homography for one fovea (main, off the camera
    // loop — driven by the tracker's own detection tick) and ship it to the
    // worker, which warps the fovea frame through it. `wrapPerspective` (the
    // heavy full-frame remap) now lives in the worker, not here.
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

    // The worker posts the raw fovea preview ("L"/"R") + the warped overlay
    // ("proj_L"/"proj_R"); publish each to the renderer.
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

    // Resource-scoped activation (A-P1): cleanups drain LIFO on idle; leases go
    // through `scope.use` so they release LAST.
    async function activateSession(scope: ResourceScope): Promise<void> {
      const t = await scope.use(() => acquireTriple(s), releaseLeases);
      if (!t) return;
      triple = t;
      scope.defer(() => {
        triple = null;
      });
      trackers = createTrackerTriple(
        { L: t.leases.L.camera, C: t.leases.C.camera, R: t.leases.R.camera },
        s.state.targetId,
        { internal: true },
      );
      scope.defer(() => {
        trackers = stopTriple(trackers);
      });

      const pipeIds: string[] = [];
      const pipes: PipeInput[] = [
        connectPipe("L", t.leases.L.camera.serial, pipeIds),
        connectPipe("R", t.leases.R.camera.serial, pipeIds),
      ];
      worker = createVisionWorker({ pipes, params: { kind: "distortion" } }, onResult);
      scope.defer(() => {
        worker?.terminate();
        worker = null;
        for (const id of pipeIds) broker.disconnect(id);
      });

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
      scope.defer(() => taps.dispose());

      loop = startActuationLoop({
        targetVolts: () => {
          if (!centerAngle) return { l: ORIGIN, r: ORIGIN };
          return { l: triple!.conv.A2V.L(centerAngle), r: triple!.conv.A2V.R(centerAngle) };
        },
        onVolts() {
          /* no telemetry needed beyond what the trackers already publish */
        },
      });
      scope.defer(() => {
        loop?.stop();
        loop = null;
      });
      s.telemetry({ ready: true });
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
      },
    };
  });
}
