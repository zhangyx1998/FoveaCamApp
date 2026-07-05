// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-drift session (docs/refactor/orchestrator.md §7.1 S1b): three
// simultaneous `MarkerTracker`s (one per fovea + the wide camera) plus a
// background visual-servo (`@orchestrator/marker-tracker`'s `startServo`)
// that keeps the mirrors pointed at the tracked markers, drift-corrected.
// No wizard steps — continuous live tracking, same as the original renderer
// implementation, just moved off it.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { leaseCalibratedTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { toFramePayload } from "@orchestrator/camera";
import { read, write } from "@orchestrator/store-hub";
import { activeController } from "@orchestrator/controller";
import { MarkerDetector } from "core/Vision";
import { MarkerTracker, startServo, type Servo } from "@orchestrator/marker-tracker";
import type { Point2d } from "core/Geometry";
import type { Mat } from "core/Vision";
import { calibrateDrift, type DetectionView } from "./contract";

// Mirror position is owned by the shared controller holder, not this
// session — read it the same way `orchestrator/actuation.ts` does.
function activeControllerPos(): { left: Point2d; right: Point2d } | null {
  const c = activeController();
  return c ? c.pos : null;
}

type Role = "L" | "C" | "R";
type DriftPair = { L: Point2d | null; R: Point2d | null };

export default function calibrateDriftSession(): ServerSession<typeof calibrateDrift> {
  return defineSession("calibrate-drift", calibrateDrift, (s) => {
    let triple: CalibratedTriple | null = null;
    const disposers: Array<() => void> = [];
    let trackers: Record<Role, MarkerTracker> | null = null;
    let servo: Servo | null = null;
    let saved: DriftPair = { L: null, R: null };

    function angularFromCenter(): Point2d | null {
      if (!triple?.undistort || !trackers) return null;
      const c = trackers.C.centerAbsolute;
      if (!c) return null;
      return triple.undistort.angular([c], true)[0];
    }

    function applyDrift(r: Point2d, d: Point2d | null): Point2d {
      return { x: r.x + (d?.x ?? 0), y: r.y + (d?.y ?? 0) };
    }

    function deriveDrift(fovea: Point2d | null): Point2d | null {
      const r = angularFromCenter();
      return r && fovea ? { x: r.x - fovea.x, y: r.y - fovea.y } : null;
    }

    function publishDetections(): void {
      if (!trackers) return;
      const view = (t: MarkerTracker): DetectionView =>
        t.target ? { points: t.target.img_pts } : null;
      s.telemetry({
        detection: { L: view(trackers.L), C: view(trackers.C), R: view(trackers.R) },
        center_angle: angularFromCenter(),
      });
    }

    function onView(role: Role, raw: Mat<Uint8Array>): void {
      s.frame(role, toFramePayload(raw));
    }

    async function activateSession(): Promise<void> {
      const t = await leaseCalibratedTriple();
      if (!t) {
        s.telemetry({ ready: false });
        return;
      }
      triple = t;
      const doc = await read<{ drift_l?: Point2d; drift_r?: Point2d }>(t.configPath, {});
      saved = { L: doc.drift_l ?? null, R: doc.drift_r ?? null };
      s.telemetry({ saved });
      const detector = new MarkerDetector("4X4_50");
      trackers = {
        L: new MarkerTracker(t.leases.L.camera, detector, s.state.target_id.L, 0.25),
        C: new MarkerTracker(t.leases.C.camera, detector, s.state.target_id.C, 1.0),
        R: new MarkerTracker(t.leases.R.camera, detector, s.state.target_id.R, 0.25),
      };
      disposers.push(trackers.L.onDetection(publishDetections));
      disposers.push(trackers.C.onDetection(publishDetections));
      disposers.push(trackers.R.onDetection(publishDetections));
      disposers.push(t.leases.L.onView((v) => onView("L", v)));
      disposers.push(t.leases.C.onView((v) => onView("C", v)));
      disposers.push(t.leases.R.onView((v) => onView("R", v)));

      servo = startServo(trackers.L, trackers.R, {
        kp: 10.0,
        originLeft: () => {
          const r = angularFromCenter();
          return r ? triple!.conv.A2V.L(applyDrift(r, saved.L)) : { x: 0, y: 0 };
        },
        originRight: () => {
          const r = angularFromCenter();
          return r ? triple!.conv.A2V.R(applyDrift(r, saved.R)) : { x: 0, y: 0 };
        },
        overrideLeft: () => s.state.override_left,
        overrideRight: () => s.state.override_right,
      });
      s.telemetry({ ready: true });

      // Publish live derived drift at a modest rate (tracker ticks don't
      // otherwise recompute it — `derived` needs the *actuated* mirror
      // position, which only changes on the servo's own tick).
      const timer = setInterval(() => {
        if (!triple) return;
        const c = activeControllerPos();
        s.telemetry({
          derived: {
            L: c ? deriveDrift(triple.conv.V2A.L(c.left)) : null,
            R: c ? deriveDrift(triple.conv.V2A.R(c.right)) : null,
          },
        });
      }, 200);
      disposers.push(() => clearInterval(timer));
    }

    function idleSession(): void {
      servo?.stop();
      servo = null;
      if (trackers) for (const t of Object.values(trackers)) t.stop();
      trackers = null;
      for (const d of disposers) d();
      disposers.length = 0;
      if (triple) for (const l of Object.values(triple.leases)) l.release();
      triple = null;
      s.telemetry({
        ready: false,
        detection: { L: null, C: null, R: null },
        center_angle: null,
        derived: { L: null, R: null },
      });
    }

    return {
      commands: {
        async setTargetId({ role, id }) {
          s.setState("target_id", { ...s.state.target_id, [role]: id });
          if (trackers) trackers[role].targetId = id;
        },
        async setOverride({ role, pos }) {
          s.setState(role === "left" ? "override_left" : "override_right", pos);
        },
        async updateDrift({ role }) {
          if (!triple) return;
          const c = activeControllerPos();
          if (!c) return;
          const nextL = role !== "R" ? deriveDrift(triple.conv.V2A.L(c.left)) : saved.L;
          const nextR = role !== "L" ? deriveDrift(triple.conv.V2A.R(c.right)) : saved.R;
          saved = { L: nextL, R: nextR };
          await write(triple.configPath, {
            ...(await read(triple.configPath, {})),
            drift_l: saved.L,
            drift_r: saved.R,
          });
          s.telemetry({ saved });
        },
        async clearDrift({ role }) {
          if (!triple) return;
          saved = {
            L: role !== "R" ? null : saved.L,
            R: role !== "L" ? null : saved.R,
          };
          await write(triple.configPath, {
            ...(await read(triple.configPath, {})),
            drift_l: saved.L,
            drift_r: saved.R,
          });
          s.telemetry({ saved });
        },
      },
      activate() {
        void activateSession();
      },
      idle: idleSession,
    };
  });
}
