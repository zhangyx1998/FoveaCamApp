// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-distortion session (docs/refactor/orchestrator.md §7.1 S1b):
// projector-alignment/homography validation. Three `MarkerTracker`s (L/R
// with subpixel `internal` refinement, matching the original); the center
// tracker's observed angle continuously points both mirrors there (via
// `startActuationLoop`, fixed-rate — the original was event-driven off a
// single `for await` chain, but re-sending the same target at a high fixed
// rate is harmless and consistent with every other control-loop session
// here); each fovea's `onView` tap derives a live homography between what
// it actually sees and where the marker "should" project, then warps its
// own frame through it as a visual alignment check.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { leaseCalibratedTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { toFramePayload } from "@orchestrator/camera";
import { MarkerDetector, findHomography, resize, wrapPerspective, type Mat } from "core/Vision";
import { area, type Point2d } from "core/Geometry";
import { MarkerTracker, type TrackerTarget } from "@orchestrator/marker-tracker";
import {
  bilinearInterpolate,
  CORNER_OBJ_POINTS,
  relativeToAbsolute,
  transformPoints,
} from "@lib/marker";
import type { Pos } from "@lib/controller-codec";
import { calibrateDistortion, type DetectionView, type ProjectionView } from "./contract";

type Role = "L" | "C" | "R";
const ORIGIN: Pos = { x: 0, y: 0 };

export default function calibrateDistortionSession(): ServerSession<typeof calibrateDistortion> {
  return defineSession("calibrate-distortion", calibrateDistortion, (s) => {
    let triple: CalibratedTriple | null = null;
    const disposers: Array<() => void> = [];
    let trackers: Record<Role, MarkerTracker> | null = null;
    let loop: ActuationLoop | null = null;
    let centerAngle: Point2d | null = null;
    const projBusy: Record<"L" | "R", boolean> = { L: false, R: false };

    function publishDetections(): void {
      if (!trackers) return;
      const view = (t: MarkerTracker): DetectionView => (t.target ? { points: t.target.img_pts } : null);
      s.telemetry({ detection: { L: view(trackers.L), C: view(trackers.C), R: view(trackers.R) } });
    }

    // Mirrors calibrate-intrinsic's `views` pattern — `s.telemetry()` is
    // publish-only, so a local mirror is needed to merge one role's update
    // without clobbering the other's.
    let currentProjection: Record<"L" | "R", ProjectionView> = { L: null, R: null };

    function onCenterDetection(): void {
      if (!triple?.undistort || !trackers) return;
      const c = trackers.C.centerAbsolute;
      centerAngle = c ? triple.undistort.angular([c], true)[0] : null;
      publishDetections();
    }

    async function computeProjection(role: "L" | "R", target: TrackerTarget, rgba: Mat<Uint8Array>): Promise<void> {
      const c = trackers![role].centerAbsolute;
      if (!c || !centerAngle) return;
      const scale = Math.sqrt(area(target));
      const dst_corners = relativeToAbsolute(transformPoints(CORNER_OBJ_POINTS, centerAngle, 1000), c, scale);
      const dst_img_pts = bilinearInterpolate(dst_corners, target.obj_pts);
      const H = await findHomography(target.img_pts, dst_img_pts);
      const warped = await wrapPerspective(rgba, H);
      s.frame(`proj_${role}`, toFramePayload(warped));
      const view: ProjectionView = { H: Array.from(H as unknown as ArrayLike<number>), points: dst_img_pts };
      currentProjection = { ...currentProjection, [role]: view };
      s.telemetry({ projection: currentProjection });
    }

    function onFoveaView(role: "L" | "R", raw: Mat<Uint8Array>): void {
      s.frame(role, toFramePayload(raw));
      const target = trackers?.[role].target;
      if (!target || projBusy[role]) return;
      projBusy[role] = true;
      const [h, w] = raw.shape;
      // `resize()` is called synchronously, right here, before any `await`
      // — its synchronous prefix reads `raw` (the registry's reused preview
      // buffer, valid only for this call) immediately, same reasoning as
      // every other session's `onView` tap deriving something retainable
      // from a shared-buffer Mat.
      const copy = resize(raw, { width: w, height: h });
      void (async () => {
        try {
          const rgba = await copy;
          await computeProjection(role, target, rgba);
        } catch (e) {
          console.error(`[calibrate-distortion] projection ${role}:`, e);
        } finally {
          projBusy[role] = false;
        }
      })();
    }

    async function activateSession(): Promise<void> {
      const t = await leaseCalibratedTriple();
      if (!t) {
        s.telemetry({ ready: false });
        return;
      }
      triple = t;
      const detector = new MarkerDetector("4X4_50");
      trackers = {
        L: new MarkerTracker(t.leases.L.camera, detector, s.state.target_id.L, 0.25, true),
        C: new MarkerTracker(t.leases.C.camera, detector, s.state.target_id.C, 1.0),
        R: new MarkerTracker(t.leases.R.camera, detector, s.state.target_id.R, 0.25, true),
      };
      disposers.push(trackers.L.onDetection(publishDetections));
      disposers.push(trackers.C.onDetection(onCenterDetection));
      disposers.push(trackers.R.onDetection(publishDetections));
      disposers.push(t.leases.L.onView((v) => onFoveaView("L", v)));
      disposers.push(t.leases.C.onView((v) => s.frame("C", toFramePayload(v))));
      disposers.push(t.leases.R.onView((v) => onFoveaView("R", v)));

      loop = startActuationLoop({
        targetVolts: () => {
          if (!centerAngle) return { l: ORIGIN, r: ORIGIN };
          return { l: triple!.conv.A2V.L(centerAngle), r: triple!.conv.A2V.R(centerAngle) };
        },
        onVolts() {
          /* no telemetry needed beyond what the trackers already publish */
        },
      });
      s.telemetry({ ready: true });
    }

    function idleSession(): void {
      loop?.stop();
      loop = null;
      if (trackers) for (const t of Object.values(trackers)) t.stop();
      trackers = null;
      for (const d of disposers) d();
      disposers.length = 0;
      if (triple) for (const l of Object.values(triple.leases)) l.release();
      triple = null;
      centerAngle = null;
      currentProjection = { L: null, R: null };
      s.telemetry({
        ready: false,
        detection: { L: null, C: null, R: null },
        projection: { L: null, R: null },
      });
    }

    return {
      commands: {
        async setTargetId({ role, id }) {
          s.setState("target_id", { ...s.state.target_id, [role]: id });
          if (trackers) trackers[role].targetId = id;
        },
      },
      activate() {
        void activateSession();
      },
      idle: idleSession,
    };
  });
}
