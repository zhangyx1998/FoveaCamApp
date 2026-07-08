// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disparity-scope session — auto-vergence. C-22b (WS1 real-1f): the per-frame
// VISION is now off the orchestrator JS event loop, in a per-session vision
// WORKER thread (`@orchestrator/vision-worker`, disparity kernel in `./vision`).
// This module is the thin main-thread coordinator it always should have been:
//
//  - on acquire: `acquireTriple` (calibration), `broker.connect` the three
//    `camera:<serial>` pipes (refcount++ → C-21 gate → converter runs), spawn
//    the worker with the pipe `shmName`s + initial params, start the fixed-rate
//    `startActuationLoop`;
//  - the worker SHM-reads L/C/R, runs KCF + `wrapPerspective` + tiles + `diff` +
//    `analyzeVergence`, and posts scalar RESULTS + derived display frames;
//  - main consumes each result: publishes frames via `session.frame`, mirrors
//    the tracker bbox/target into state/telemetry, and runs `stepVergence`/PID
//    → `commandedVolts` (calibration + control stay here, never in the worker);
//  - `startActuationLoop` reads `commandedVolts` synchronously every tick.
//
// Homographies: the worker's `wrapPerspective` needs each fovea's current pose
// as a matrix. Main computes `conv.A2H[role](V2A[role](volts))` and pushes the
// 9 numbers as params (throttled with the volt telemetry) — the worker needs no
// calibration reconstruction. This replaces the old registry `onView` taps +
// `@orchestrator/async-kcf` (deleted here — disparity was its last consumer):
// the single-threaded worker loop makes KCF synchronous again (no busy-drop
// dance). C-22b step 3 finished the job — every session's vision now runs in a
// worker thread, and the registry view-tap loop + `frame-worker` are retired.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { DisposerBag, publishSerials, releaseLeases } from "@orchestrator/session-resources";
import { ORIGIN_POS, radians, VOLT_TELEMETRY_INTERVAL_MS } from "@orchestrator/fovea-pipeline";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import {
  disparity,
  DEFAULT_TUNING,
  VERGE_MIN_DISTANCE_MM,
  SHIFT_LIMIT_DEG,
  VSHIFT_LIMIT_DEG,
  type Tuning,
  type PidReadout,
} from "./contract";
import { stepVergence, type VergencePIDs } from "./vergence";
import type { DisparityParams, DisparityValues } from "./vision";
import { makeMat } from "@lib/mat";
import { PID } from "@lib/pid";
import { distanceToVerge, vergeToDistance, vergenceToDistance } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";
import type { Mat } from "core/Vision";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";

const ZERO: Point2d = { x: 0, y: 0 };
const now = () => performance.now();

const SHIFT_LIMIT = radians(SHIFT_LIMIT_DEG);
const VSHIFT_LIMIT = radians(VSHIFT_LIMIT_DEG);
const DT_MAX_FRAMES = 10;
const TRACKER_LOST_TOLERANCE = 10;

function cloneTuning(t: Tuning): Tuning {
  return {
    pan: [...t.pan],
    depth: [...t.depth],
    v_shift: [...t.v_shift],
    sensitivity: t.sensitivity,
    scale: t.scale,
    min_score: t.min_score,
    expand_x: t.expand_x,
    expand_y: t.expand_y,
    timeout: t.timeout,
  };
}

export default function disparityScopeSession(
  broker: PipeBroker,
): ServerSession<typeof disparity> {
  return defineSession("disparity-scope", disparity, (s) => {
    let triple: CalibratedTriple | null = null;
    const disposers = new DisposerBag();
    let loop: ActuationLoop | null = null;
    let worker: VisionWorkerHandle | null = null;

    let dragging = false;
    let windowStart = now();
    let lastStep = now();
    let lastVoltEmit = 0;
    let lastHomographyPush = 0;
    let status = "initializing";
    // Mirror of the worker's tracker liveness (drives `frozen()` + freeze reset).
    let trackerActive = false;
    let lastGood: Point2d = ZERO;

    // Commanded volts, updated by the (worker-driven) vergence step and read
    // synchronously every actuation tick.
    let commandedVolts: { l: Pos; r: Pos } = { l: ORIGIN_POS, r: ORIGIN_POS };
    // Latest actuated volts, mirrored locally (needed for the wrap homography
    // and the vergence/distance telemetry).
    const volts: { L: Pos; R: Pos } = { L: { ...ORIGIN_POS }, R: { ...ORIGIN_POS } };
    const actuateMsStats = new RollingStats(0.9, 2, "ms");

    const pids: VergencePIDs = {
      panX: new PID({ limits: [-SHIFT_LIMIT, SHIFT_LIMIT] }),
      panY: new PID({ limits: [-SHIFT_LIMIT, SHIFT_LIMIT] }),
      verge: new PID({
        limits: [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, s.state.baseline)],
      }),
      v_shift: new PID({ limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT] }),
    };

    function syncGains(t: Tuning): void {
      pids.panX.kp = pids.panY.kp = t.pan[0];
      pids.panX.ki = pids.panY.ki = t.pan[1];
      pids.panX.kd = pids.panY.kd = t.pan[2];
      pids.verge.kp = t.depth[0];
      pids.verge.ki = t.depth[1];
      pids.verge.kd = t.depth[2];
      pids.v_shift.kp = t.v_shift[0];
      pids.v_shift.ki = t.v_shift[1];
      pids.v_shift.kd = t.v_shift[2];
    }
    syncGains(s.state.tuning);

    function effectiveScale(): number {
      const zoom = Math.max(1, s.state.zoom);
      const ratio = Math.max(0, Math.min(1, s.state.tuning.scale));
      return 1 + (zoom - 1) * ratio;
    }

    function frozen(): boolean {
      if (trackerActive) return false; // actively tracking: never freeze
      const t = s.state.tuning.timeout;
      const timeoutMs = t > 0 ? t : Infinity;
      return timeoutMs !== Infinity && now() - windowStart > timeoutMs;
    }

    // --- worker params ----------------------------------------------------

    /** Flat 9-number homographies for both foveas at the current pose. */
    function homographyParams(): Partial<DisparityParams> {
      if (!triple) return {};
      const HL = triple.conv.A2H.L(triple.conv.V2A.L(volts.L));
      const HR = triple.conv.A2H.R(triple.conv.V2A.R(volts.R));
      return {
        homographyL: Array.from(HL as unknown as Float64Array),
        homographyR: Array.from(HR as unknown as Float64Array),
      };
    }

    function sendParams(params: Partial<DisparityParams>): void {
      worker?.sendParams(params as Record<string, unknown>);
    }

    function initParams(): Record<string, unknown> {
      return {
        kind: "disparity",
        kernelW: s.state.kernel.w,
        kernelH: s.state.kernel.h,
        zoom: Math.max(1, s.state.zoom),
        scale: effectiveScale(),
        target: s.state.target,
        expand_x: s.state.tuning.expand_x,
        expand_y: s.state.tuning.expand_y,
        view: s.state.view,
        wrap: s.state.wrap,
        lostTolerance: TRACKER_LOST_TOLERANCE,
        trackerInit: s.state.tracker_enabled ? s.state.target : null,
        ...homographyParams(),
      };
    }

    // --- worker results ---------------------------------------------------

    function onResult(r: VisionResult): void {
      const v = r.values as DisparityValues;
      if (v.size) s.telemetry({ size: v.size });
      if (v.tracker) {
        if (v.tracker.status === "tracking") {
          trackerActive = true;
          lastGood = v.tracker.center;
          s.setState("target", v.tracker.center);
          s.telemetry({ tracker_bbox: v.tracker.bbox });
        } else {
          trackerActive = false;
          s.setState("target", lastGood);
          s.telemetry({ tracker_bbox: null });
        }
      }
      for (const f of r.frames) {
        s.frame(f.name, makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels));
      }
      if (v.analysis) {
        s.telemetry({
          match_left: v.analysis.ml,
          match_right: v.analysis.mr,
          match_center: v.analysis.center,
        });
        runStep(v.analysis);
      }
    }

    function runStep(analysis: NonNullable<DisparityValues["analysis"]>): void {
      if (!triple) return;
      const undistort = triple.undistort;
      if (!undistort) {
        status = "no calibration";
        return;
      }
      if (dragging) {
        status = "manual";
        const ray = undistort.angular([s.state.target], true)[0];
        commandedVolts = { l: triple.conv.A2V.L(ray), r: triple.conv.A2V.R(ray) };
        return;
      }
      if (frozen()) {
        status = "frozen";
        return;
      }
      const t = now();
      const dt = Math.min((t - lastStep) * s.state.tuning.sensitivity, DT_MAX_FRAMES);
      const result = stepVergence(
        analysis,
        pids,
        { P2A: triple.conv.P2A, A2V: triple.conv.A2V },
        { baseline: s.state.baseline, minScore: s.state.tuning.min_score },
        dt,
      );
      if (!result) {
        status = "low score";
        return;
      }
      lastStep = t;
      status = "tracking";
      commandedVolts = { l: result.left, r: result.right };
    }

    // --- actuation (fixed-rate, decoupled from vision fps) ----------------

    function targetVolts(): { l: Pos; r: Pos } {
      return commandedVolts;
    }

    function onVolts(vv: { L: Pos; R: Pos }, actuateMs: number): void {
      volts.L = vv.L;
      volts.R = vv.R;
      actuateMsStats.push(actuateMs);
      const t = now();
      // Push updated wrap homographies at the volt-telemetry cadence (cheap: 18
      // numbers) — a slightly stale wrap is fine, the loop feeds back on the
      // image match, not the calibration prediction.
      if (t - lastHomographyPush >= VOLT_TELEMETRY_INTERVAL_MS) {
        lastHomographyPush = t;
        sendParams(homographyParams());
      }
      if (t - lastVoltEmit < VOLT_TELEMETRY_INTERVAL_MS) return;
      lastVoltEmit = t;
      const vergence = triple ? triple.conv.V2A.L(vv.L).x - triple.conv.V2A.R(vv.R).x : 0;
      const realized_distance = vergenceToDistance(vergence, s.state.baseline / 1000);
      const commanded_distance = vergeToDistance(pids.verge.value, s.state.baseline);
      const PX = (role: "L" | "R"): Point2d =>
        triple ? triple.conv.A2P.C(triple.conv.V2A[role](vv[role])) : ZERO;
      const readout: PidReadout = {
        verge: pids.verge.value,
        panX: pids.panX.value,
        panY: pids.panY.value,
        v_shift: pids.v_shift.value,
      };
      s.telemetry({
        volt: vv,
        vergence,
        realized_distance,
        commanded_distance,
        L_PX: PX("L"),
        R_PX: PX("R"),
        status,
        pids: readout,
        perf: { actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max } },
      });
      actuateMsStats.resetMax();
    }

    // --- lifecycle --------------------------------------------------------

    /** Connect a `camera:<serial>` pipe (refcount++ → C-21 gate) and return its
     *  worker `PipeInput`; registers the matching `disconnect` on `disposers`. */
    function connectCameraPipe(role: "L" | "C" | "R", serial: string): PipeInput {
      const pipeId = `camera:${serial}`;
      const handle = broker.connect(pipeId);
      disposers.add(() => broker.disconnect(pipeId));
      const { width, height, channels, bytesPerFrame, maxBytes } = handle.spec;
      return {
        role,
        shmName: handle.shmName,
        width,
        height,
        channels,
        bytesPerFrame: maxBytes ?? bytesPerFrame,
      };
    }

    async function activateSession(): Promise<void> {
      const t = await acquireTriple(s);
      if (!t) return;
      triple = t;
      publishSerials(t.leases, disposers, s);
      const pipeInputs: PipeInput[] = [
        connectCameraPipe("L", t.leases.L.camera.serial),
        connectCameraPipe("C", t.leases.C.camera.serial),
        connectCameraPipe("R", t.leases.R.camera.serial),
      ];
      worker = createVisionWorker({ pipes: pipeInputs, params: initParams() }, onResult);
      loop = startActuationLoop({ targetVolts, onVolts });
      s.telemetry({ ready: true });
    }

    function idleSession(): void {
      loop?.stop();
      loop = null;
      worker?.terminate(); // terminate before disconnect: no reads after the gate drops
      worker = null;
      trackerActive = false;
      disposers.dispose(); // disconnects the pipes (gate → converter unsubscribe)
      releaseLeases(triple);
      triple = null;
      status = "initializing";
      commandedVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
      s.resetTelemetry(["ready", "status", "tracker_bbox"]);
    }

    return {
      commands: {
        async pointer({ p, buttons: _buttons, phase }) {
          if (phase === "down") {
            trackerActive = false;
            sendParams({ trackerRelease: true, target: p });
            s.telemetry({ tracker_bbox: null });
            dragging = true;
          }
          if (phase !== "up") {
            s.setState("target", p);
            sendParams({ target: p });
          } else {
            dragging = false;
            windowStart = now();
            for (const pid of Object.values(pids)) pid.reset();
            if (s.state.tracker_enabled) sendParams({ trackerInit: s.state.target });
          }
        },
        async resetTuning() {
          s.setState("tuning", cloneTuning(DEFAULT_TUNING));
        },
        async reset_vergence() {
          for (const pid of Object.values(pids)) pid.reset();
        },
        async setPid({ dof, value }) {
          pids[dof].value = value;
        },
      },
      watch: {
        tuning(t) {
          syncGains(t);
          sendParams({
            scale: effectiveScale(),
            expand_x: t.expand_x,
            expand_y: t.expand_y,
          });
        },
        baseline(v) {
          pids.verge.limits = [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, v)];
        },
        zoom() {
          sendParams({ zoom: Math.max(1, s.state.zoom), scale: effectiveScale() });
        },
        view(view) {
          sendParams({ view });
        },
        wrap(wrap) {
          sendParams({ wrap });
        },
        kernel(k) {
          sendParams({ kernelW: k.w, kernelH: k.h });
        },
        tracker_enabled(on) {
          if (!on) {
            trackerActive = false;
            sendParams({ trackerRelease: true });
            s.telemetry({ tracker_bbox: null });
          } else if (!dragging) {
            sendParams({ trackerInit: s.state.target });
          }
        },
      },
      activate() {
        void activateSession();
      },
      idle: idleSession,
    };
  });
}
