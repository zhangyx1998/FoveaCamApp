// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-drift session (docs/history/refactor/orchestrator.md §7.1 S1b): three
// simultaneous `MarkerTracker`s (one per fovea + the wide camera) plus a
// background visual-servo (`@orchestrator/marker-tracker`'s `startServo`)
// that keeps the mirrors pointed at the tracked markers, drift-corrected.
// No wizard steps — continuous live tracking, same as the original renderer
// implementation, just moved off it.

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { read, write } from "@orchestrator/store-hub";
import { activeController } from "@orchestrator/controller";
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
import type { Point2d } from "core/Geometry";
import { calibrateDrift } from "./contract";

// Mirror position is owned by the shared controller holder, not this
// session — read it the same way `orchestrator/actuation.ts` does.
function activeControllerPos(): { left: Point2d; right: Point2d } | null {
  const c = activeController();
  return c ? c.pos : null;
}

type Role = "L" | "C" | "R";
type DriftPair = { L: Point2d | null; R: Point2d | null };

export default function calibrateDriftSession(): ServerSession<typeof calibrateDrift> {
  return defineResourceSession("calibrate-drift", calibrateDrift, (s) => {
    let triple: CalibratedTriple | null = null;
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
      s.telemetry({
        detection: detectionViews(trackers),
        center_angle: angularFromCenter(),
      });
    }

    // Resource-scoped activation (A-P1): every resource registers a cleanup on
    // `scope`, drained LIFO on idle (and immediately if a slow activation is
    // superseded). Leases go through `scope.use` so they release LAST, after
    // the servo/trackers/taps that read them have stopped.
    async function activateSession(scope: ResourceScope): Promise<void> {
      const t = await scope.use(() => acquireTriple(s), releaseLeases);
      if (!t) return; // no cameras (acquireTriple published fail) or superseded
      triple = t;
      scope.defer(() => {
        triple = null;
      });
      const doc = await read<{ drift_l?: Point2d; drift_r?: Point2d }>(t.configPath, {});
      if (scope.cancelled) return;
      saved = { L: doc.drift_l ?? null, R: doc.drift_r ?? null };
      s.telemetry({ saved });
      trackers = createTrackerTriple(
        { L: t.leases.L.camera, C: t.leases.C.camera, R: t.leases.R.camera },
        s.state.targetId,
      );
      scope.defer(() => {
        trackers = stopTriple(trackers);
      });
      const taps = new DisposerBag();
      bindDetections(trackers, taps, publishDetections);
      // Raw L/C/R previews ride the native `camera:<serial>` pipe (usePipeFrame
      // in index.vue, discovered via publishSerials) — no JS `onView` view-tap
      // (A-31, real-1f step 3). Marker detection stays off-loop on
      // `detector.stream`, so this session no longer taps `onView` at all.
      publishSerials(t.leases, taps, s);
      scope.defer(() => taps.dispose());

      servo = startServo(trackers.L, trackers.R, {
        kp: 10.0,
        owner: "calibrate-drift",
        originLeft: () => {
          const r = angularFromCenter();
          return r ? triple!.conv.A2V.L(applyDrift(r, saved.L)) : { x: 0, y: 0 };
        },
        originRight: () => {
          const r = angularFromCenter();
          return r ? triple!.conv.A2V.R(applyDrift(r, saved.R)) : { x: 0, y: 0 };
        },
      });
      // A fresh servo's per-eye override slots start released — mirror that into
      // contract state so a stale engaged echo can't survive a reactivation.
      s.setState("pidOverrideL", { engaged: false, value: null });
      s.setState("pidOverrideR", { engaged: false, value: null });
      scope.defer(() => {
        servo?.stop();
        servo = null;
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
      scope.defer(() => clearInterval(timer));
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        s.resetTelemetry(["ready", "detection", "center_angle", "derived"]);
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
    };
  });
}
