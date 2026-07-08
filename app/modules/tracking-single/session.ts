// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Single-target tracking session — the first frame-driven control loop moved off
// the renderer (§5.4). The orchestrator leases the calibrated L/C/R triple, runs
// the KCF tracker on its OWN native C++ thread (WS1 1d, `createTracker`) reading
// the shared center stream, and drives the actuation loop against the shared
// serial controller. The renderer is a thin client.
//
// C-22b step 2: the PROCESSED DISPLAY views (undistorted center + magnified
// slice, perspective-wrapped foveae, combined diff/depth) moved OFF the JS event
// loop into the shared `display` vision worker kernel — the registry `onView`
// taps + per-view `frame-worker`s are gone. Main connects the three
// `camera:<serial>` SHM pipes (C-21 gate), spawns the worker with the serialized
// calibration + initial params, and pushes fovea homographies / depth Q-matrix /
// slice-center as params (recomputed on each throttled volt/target update). The
// worker posts back the processed frames + learned size. The native KCF thread
// is UNCHANGED — it reads the raw center stream directly, not the pipe.

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { DisposerBag, publishSerials, releaseLeases } from "@orchestrator/session-resources";
import {
  clampRectToSize,
  depthFromInverse,
  ORIGIN_POS,
  radians,
  VOLT_TELEMETRY_INTERVAL_MS,
} from "@orchestrator/fovea-pipeline";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import type { DisplayParams, DisplayValues } from "@orchestrator/display-transport";
import {
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import { tracking } from "./contract";
import { KinematicModel } from "./kinematic";
import { RECT } from "@lib/util/geometry";
import { createQMatrix, deriveFoveaIntrinsics } from "@lib/stereo";
import { makeMat } from "@lib/mat";
import { createTracker, type KcfTracker, type TrackerMeter } from "core/Tracker";
import { consumeTrackerResults } from "./tracker-consume";
import { registerNativeProbe } from "@orchestrator/native-probes";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";
import type { Point2d, Rect } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { RollingStats } from "@lib/util/rolling";

const now = () => performance.now();

// A-24 Stage 3: adapt B's native tracker meter (`uptimeMs`/`dropTotal`) to the
// `WorkloadSnapshot` shape `perfSnapshot.workloads` uses.
function trackerWorkload(m: TrackerMeter): WorkloadSnapshot {
  const t = Date.now();
  return {
    name: "tracking:kcf",
    window: { startedAt: t - m.uptimeMs, snapshotAt: t, uptimeMs: m.uptimeMs },
    utilization: m.utilization,
    busyMs: m.busyMs,
    inputs: m.inputs,
    outputs: m.outputs,
    drops: { total: m.dropTotal, ratePerSec: 0, byReason: {} },
  };
}

export default function trackingSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
): ServerSession<typeof tracking> {
  return defineResourceSession("tracking", tracking, (s) => {
    let triple: CalibratedTriple | null = null;
    let loop: ActuationLoop | null = null;
    let worker: VisionWorkerHandle | null = null;

    // Center-frame geometry, learned from the worker's processed center.
    let width = 0;
    let height = 0;

    // Target state (undistorted center-frame pixels, the actuation math's space).
    let target: Point2d = { x: 0, y: 0 };
    const kinematic = new KinematicModel(() => s.state.pred_buffer_max);
    // WS1 1d: the KCF runs on its own free-running C++ thread reading the LATEST
    // center-camera frame off the JS loop. `tk` is created per activation;
    // `armed` gates JS-side publishing (no native disarm — release kills it).
    let tk: KcfTracker | null = null;
    let armed = false;
    let lastGood: Point2d = { x: 0, y: 0 };
    // Latest commanded voltages, mirrored locally for the fovea-wrap homography.
    const volts: { L: Pos; R: Pos } = { L: { ...ORIGIN_POS }, R: { ...ORIGIN_POS } };

    const trackMsStats = new RollingStats(0.9, 2, "ms");
    const actuateMsStats = new RollingStats(0.9, 2, "ms");
    const frameAgeStats = new RollingStats(0.9, 2, "ms");
    let lastFrameTime: number | null = null;

    // --- native KCF tracker (unchanged; reads the raw center stream) ------

    function disengage(publish = true): void {
      armed = false;
      kinematic.reset();
      if (publish) s.telemetry({ active: false, bbox: null });
    }

    /** Arm the native tracker at a clicked center (undistorted display pixels).
     *  Round-trips the click to a RAW sensor box (what the native full-frame KCF
     *  wants — it reads the raw center stream). */
    function armAt(center: Point2d): void {
      const undistort = triple?.undistort;
      if (!undistort || !tk) return;
      const size = { width: s.state.tracker_w, height: s.state.tracker_h };
      // The native full-frame KCF reads the RAW center stream, so arm it in RAW
      // sensor pixels: undistorted click → angle → distorted (raw) pixel. This
      // is the exact inverse of `undistortedCenter` (which maps the native raw
      // bbox back to undistorted display space). The old code passed
      // `distort = false` to `position`, which returns the ideal/undistorted
      // pixel — i.e. it armed the tracker in the wrong space (an identity round
      // trip), grabbing the KCF template off-target by the local distortion.
      const angle = undistort.angular([center], false)[0];
      const rawCenter = undistort.position([angle], true)[0];
      const roi = RECT.fromCenter(rawCenter, size);
      const x = Math.max(0, Math.round(roi.x));
      const y = Math.max(0, Math.round(roi.y));
      const w = Math.min(width - x, Math.round(roi.width));
      const h = Math.min(height - y, Math.round(roi.height));
      if (w <= 0 || h <= 0) return;
      tk.arm({ x, y, width: w, height: h });
      armed = true;
      kinematic.reset();
      lastGood = center;
      target = center;
      lastFrameTime = now();
      kinematic.push(center.x, center.y, lastFrameTime);
      // The overlay box lives in UNDISTORTED display space (its backdrop is the
      // undistorted wide view, and the target dot is undistorted) — publish it
      // centered on the click, not the raw ROI armed above.
      s.telemetry({ active: true, bbox: RECT.fromCenter(center, size), target });
    }

    /** Map a native (RAW center-pixel) bbox to the UNDISTORTED target space. */
    function undistortedCenter(bbox: Rect): Point2d {
      const raw = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
      const undistort = triple?.undistort;
      return undistort
        ? undistort.position([undistort.angular([raw], true)[0]], false)[0]
        : raw;
    }

    function consumeTracker(t: KcfTracker): Promise<void> {
      return consumeTrackerResults(t, {
        armed: () => armed,
        onFound: (bbox) => {
          const center = undistortedCenter(bbox);
          lastGood = center;
          const now_ = now();
          lastFrameTime = now_;
          kinematic.push(center.x, center.y, now_);
          target = kinematic.predict(now_) ?? center;
          // `bbox` is RAW center-sensor pixels; the overlay draws over the
          // UNDISTORTED wide view. Publish the box in undistorted space,
          // centered on the undistorted measurement (so it stays aligned with
          // the frame and the predicted-target dot) — the pre-fix code shipped
          // the raw box straight through, offset by the local distortion.
          s.telemetry({
            bbox: RECT.fromCenter(center, { width: bbox.width, height: bbox.height }),
            target,
          });
        },
        onLost: () => {
          target = lastGood;
          s.telemetry({ target });
          disengage(true);
        },
      });
    }

    // --- worker params (main computes calibration-derived matrices) -------

    /** Fovea homographies + depth Q-matrix at the current pose — pushed on each
     *  throttled volt update (cheap; the worker uses the latest). */
    function voltParams(): DisplayParams {
      if (!triple) return {};
      const HL = triple.conv.A2H.L(triple.conv.V2A.L(volts.L));
      const HR = triple.conv.A2H.R(triple.conv.V2A.R(volts.R));
      const params: DisplayParams = {
        homographyL: Array.from(HL as unknown as Float64Array),
        homographyR: Array.from(HR as unknown as Float64Array),
      };
      if (triple.undistort) {
        const zoom = Math.max(1, s.state.zoom);
        const Q = createQMatrix(
          deriveFoveaIntrinsics(triple.undistort, triple.conv.V2A.L(volts.L), zoom),
          deriveFoveaIntrinsics(triple.undistort, triple.conv.V2A.R(volts.R), zoom),
          s.state.baseline,
        );
        params.qMatrix = Array.from(Q as unknown as Float64Array);
      }
      return params;
    }

    /** The undistorted center pixel the magnified "sliced" view crops around. */
    function sliceAtParam(): DisplayParams {
      const undistort = triple?.undistort;
      const at = undistort
        ? undistort.position([undistort.angular([target], false)[0]], false)[0]
        : target;
      return { sliceAt: at };
    }

    /** Depth-heatmap clamp range for the "depth" combined view. */
    function depthParams(): DisplayParams {
      const dw = depthFromInverse(s.state.depthWindowInv) / 2;
      const d = distance();
      return { depthNear: d - dw, depthFar: d + dw };
    }

    function pushParams(params: DisplayParams): void {
      worker?.sendParams(params as Record<string, unknown>);
    }

    // --- worker results (publish processed frames + learn geometry) -------

    function onResult(r: VisionResult): void {
      const v = r.values as DisplayValues;
      if (v.size) {
        width = v.size.width;
        height = v.size.height;
        s.telemetry({ size: v.size });
      }
      for (const f of r.frames) {
        s.frame(f.name, makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels));
      }
    }

    // --- actuation (timer-driven, decoupled from tracker fps) ------------

    function distance(): number {
      const v = s.state.verge;
      return v <= 0 ? Infinity : s.state.baseline / (v * v);
    }

    function inverseTriangulate(angle: Point2d, z: number, shift: number): { l: Point2d; r: Point2d } {
      const out = { l: { ...angle }, r: { ...angle } };
      if (z < Infinity && z > 0) {
        const b = s.state.baseline / 2;
        const x = z * Math.tan(angle.x);
        out.l.x = Math.atan2(x + b, z);
        out.r.x = Math.atan2(x - b, z);
      }
      if (shift !== 0) {
        out.l.y += radians(shift);
        out.r.y -= radians(shift);
      }
      return out;
    }

    function targetVolts(): { l: Pos; r: Pos } {
      const undistort = triple?.undistort;
      if (!undistort || !triple) return { l: ORIGIN_POS, r: ORIGIN_POS };
      if (armed) {
        const p = kinematic.predict(now());
        if (p) target = p;
      }
      if (lastFrameTime !== null) frameAgeStats.push(now() - lastFrameTime);
      const angle = undistort.angular([target], false)[0];
      const A = inverseTriangulate(angle, distance(), s.state.shift);
      return { l: triple.conv.A2V.L(A.l), r: triple.conv.A2V.R(A.r) };
    }

    let lastVoltEmit = 0;
    let lastParamPush = 0;

    // --- lifecycle -------------------------------------------------------

    function initParams(): Record<string, unknown> {
      return {
        kind: "display",
        zoom: Math.max(1, s.state.zoom),
        view: s.state.view,
        wrap: s.state.wrap,
        ...voltParams(),
        ...sliceAtParam(),
        ...depthParams(),
      };
    }

    /** Connect a pipe by id (refcount++ → C-21 gate) → worker input. */
    function connectPipe(role: "L" | "C" | "R", pipeId: string, ids: string[]): PipeInput {
      const handle = broker.connect(pipeId);
      ids.push(pipeId);
      const { width: w, height: h, channels, bytesPerFrame, maxBytes } = handle.spec;
      return { role, shmName: handle.shmName, width: w, height: h, channels, bytesPerFrame: maxBytes ?? bytesPerFrame };
    }

    async function activateSession(scope: ResourceScope): Promise<void> {
      const t = await scope.use(() => acquireTriple(s), releaseLeases);
      if (!t) return;
      triple = t;
      scope.defer(() => {
        triple = null;
        width = height = 0;
        lastFrameTime = null;
      });

      // real-1g (C-23): advertise the first-class `undistort:<serial>` center
      // pipe (B's native remap producer, consumer-gated). Publish its id so the
      // renderer binds the undistorted wide view — overlays (bbox/target) are in
      // undistorted space, so this is their correct backdrop. Registered before
      // the worker's defer → retires AFTER consumers disconnect (LIFO).
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

      const pipeIds: string[] = [];
      const pipes: PipeInput[] = [
        connectPipe("L", nodeId.convert(t.leases.L.camera.serial), pipeIds),
        // The worker's C input is the UNDISTORTED stream (slice runs on it);
        // uncalibrated rigs fall back to raw — same degradation as before.
        connectPipe("C", undistortC ?? nodeId.convert(t.leases.C.camera.serial), pipeIds),
        connectPipe("R", nodeId.convert(t.leases.R.camera.serial), pipeIds),
      ];
      const taps = new DisposerBag();
      publishSerials(t.leases, taps, s);
      worker = createVisionWorker({ pipes, params: initParams() }, onResult);
      // Terminate the worker (stop SHM reads) BEFORE dropping the pipe gate, and
      // both after the tracker/loop stop but before the leases release.
      scope.defer(() => {
        worker?.terminate();
        worker = null;
        for (const id of pipeIds) broker.disconnect(id);
        taps.dispose();
      });
      scope.defer(() => disengage(false));

      tk = createTracker(t.leases.C.camera);
      scope.defer(() => {
        tk?.release();
        tk = null;
        armed = false;
      });
      scope.defer(
        registerNativeProbe(
          (): Record<string, WorkloadSnapshot> =>
            tk ? { "tracking:kcf": trackerWorkload(tk.probe()) } : {},
        ),
      );
      void consumeTracker(tk);
      loop = startActuationLoop({
        targetVolts,
        onVolts(v, actuateMs) {
          volts.L = v.L;
          volts.R = v.R;
          actuateMsStats.push(actuateMs);
          const t2 = now();
          if (t2 - lastParamPush >= VOLT_TELEMETRY_INTERVAL_MS) {
            lastParamPush = t2;
            pushParams({ ...voltParams(), ...sliceAtParam(), ...depthParams() });
          }
          if (t2 - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
            lastVoltEmit = t2;
            s.telemetry({
              volt: v,
              perf: {
                trackMs: { mean: trackMsStats.mean, max: trackMsStats.max },
                actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max },
                frameAgeAtActuate: { mean: frameAgeStats.mean, max: frameAgeStats.max },
              },
            });
            trackMsStats.resetMax();
            actuateMsStats.resetMax();
            frameAgeStats.resetMax();
          }
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
        s.resetTelemetry(["ready", "active", "bbox"]);
      },
      watch: {
        zoom() {
          pushParams({ zoom: Math.max(1, s.state.zoom), ...voltParams() });
        },
        view(view) {
          pushParams({ view });
        },
        wrap(wrap) {
          pushParams({ wrap });
        },
        baseline() {
          pushParams({ ...voltParams(), ...depthParams() });
        },
        verge() {
          pushParams(depthParams());
        },
        depthWindowInv() {
          pushParams(depthParams());
        },
      },
      commands: {
        async startTracker(center) {
          armAt(center);
          pushParams(sliceAtParam());
        },
        async releaseTracker() {
          disengage(true);
        },
        async steer(px) {
          disengage(true);
          target = px;
          s.telemetry({ target });
          pushParams(sliceAtParam());
        },
      },
    };
  });
}
