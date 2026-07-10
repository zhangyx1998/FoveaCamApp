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
import { registerGraphWiring } from "@orchestrator/graph-topology";
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
import type { PipeBroker } from "@orchestrator/pipe-session";
import { createRawRecording } from "@orchestrator/raw-recording";
import {
  createCaptureHelper,
  rawTripleShot,
  type CaptureHelper,
} from "@orchestrator/capture-helper";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import { calibrateDrift } from "./contract";
import { gateOnLock } from "./drift-gate";

// Mirror position is owned by the shared controller holder, not this
// session — under the controller node's streaming transport the holder's
// `pos` stays live via `applyStreamedPos` (controller-node.ts).
function activeControllerPos(): { left: Point2d; right: Point2d } | null {
  const c = activeController();
  return c ? c.pos : null;
}

type Role = "L" | "C" | "R";
type DriftPair = { L: Point2d | null; R: Point2d | null };

export default function calibrateDriftSession(
  broker: PipeBroker,
  rawPipes: RawPipeRegistry,
  compress?: CompressPipeSeam,
): ServerSession<typeof calibrateDrift> {
  return defineResourceSession("calibrate-drift", calibrateDrift, (s) => {
    let triple: CalibratedTriple | null = null;
    // Capture (ruling 3): degraded raw-stack capture over the leased triple.
    let captureHelper: CaptureHelper | null = null;
    let captureCenter: { shmName: string; maxBytes: number; channels: number } | null = null;
    let trackers: Record<Role, MarkerTracker> | null = null;
    let servo: Servo | null = null;
    let saved: DriftPair = { L: null, R: null };

    // Recording (capture-recorder-everywhere ruling 2): records the app's raw
    // L/C/R sensor streams (advert-verbatim, the OBVIOUS default set) via the
    // shared facility. Thin config over the leased triple's cameras.
    const recording = createRawRecording({
      id: "recorder/calibrate-drift",
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
      // Spin-up progress (ruling 2026-07-09): declare the activation steps
      // upfront so the window renders this sequence instead of blanking while
      // the graph builds. A failure/early-return leaves the list FROZEN at the
      // step it died on (never `done`/`complete`); idle teardown clears a
      // cancelled spin-up.
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing cameras" },
        { id: "config", label: "Loading drift config" },
        { id: "trackers", label: "Starting trackers" },
        { id: "servo", label: "Starting servo" },
      ]);
      monitor.start("lease");
      const t = await scope.use(() => acquireTriple(s), releaseLeases);
      if (!t) return; // no cameras (acquireTriple published fail) or superseded
      monitor.done("lease");
      triple = t;
      // DISPLAY-ONLY: profiler labels this triple by role (L/C/R), ids stay
      // serial-keyed — the one-liner every triple-holding session registers.
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
      // Finalize an in-flight recording before the lease releases (defer is LIFO
      // and leases release LAST via scope.use — this runs while cameras live).
      scope.defer(async () => void (await recording.stop()));
      scope.defer(() => {
        triple = null;
      });
      monitor.start("config");
      const doc = await read<{ drift_l?: Point2d; drift_r?: Point2d }>(t.configPath, {});
      if (scope.cancelled) return; // frozen at "Loading drift config" (scope cancel)
      saved = { L: doc.drift_l ?? null, R: doc.drift_r ?? null };
      s.telemetry({ saved });
      monitor.done("config");
      monitor.start("trackers");
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
      // Publish the leased triple's config store path so the renderer opens the
      // `["triples", <hash>]` doc reactively for LIVE per-triple baseline marker
      // spacing (per-triplet-settings wave, Ruling A).
      s.setState("configPath", t.configPath);
      scope.defer(() => s.setState("configPath", []));
      scope.defer(() => taps.dispose());
      monitor.done("trackers");

      monitor.start("servo");
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
      monitor.done("servo");

      // --- capture (ruling 3) ------------------------------------------------
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
        id: nodeId.win("calibrate-drift", "capture"),
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
                note: "calibrate-drift: raw stacks, no per-shot mirror pose (no wrap)",
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

      s.telemetry({ ready: true });

      // Publish live derived drift at a modest rate (tracker ticks don't
      // otherwise recompute it — `derived` needs the *actuated* mirror
      // position, which only changes on the servo's own tick).
      const timer = setInterval(() => {
        if (!triple) return;
        const c = activeControllerPos();
        // Gate each eye on that fovea tracker's live lock (proposal finding 1):
        // an unlocked eye's derived drift is meaningless, so publish null.
        s.telemetry({
          derived: {
            L: gateOnLock(c ? deriveDrift(triple.conv.V2A.L(c.left)) : null, trackers?.L),
            R: gateOnLock(c ? deriveDrift(triple.conv.V2A.R(c.right)) : null, trackers?.R),
          },
        });
      }, 200);
      scope.defer(() => clearInterval(timer));
      monitor.complete(); // spin-up finished — clear the overlay
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
          // Defense in depth (proposal finding 1): only commit an eye whose fovea
          // tracker is currently locked — otherwise keep the saved value untouched.
          const canL = !!trackers?.L.target;
          const canR = !!trackers?.R.target;
          const nextL = role !== "R" && canL ? deriveDrift(triple.conv.V2A.L(c.left)) : saved.L;
          const nextR = role !== "L" && canR ? deriveDrift(triple.conv.V2A.R(c.right)) : saved.R;
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
      busy() {
        // Drain refusal (manual-control pattern): don't force-drain mid-record/capture.
        if (captureHelper?.capturing) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}
