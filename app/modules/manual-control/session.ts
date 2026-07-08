// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Manual-control session — same substrate as tracking-single (calibrated
// L/C/R triple + timer-paced actuation) minus the KCF tracker: the target is
// always whatever `steer` last set, either a mouse-drag pixel (converted
// server-side via `undistort.angular`) or a locally-held set-point's angle.
// Capture and recording (docs/refactor/orchestrator.md roadmap item 6) are
// wired in separately — see `capture.ts`/`recording.ts`.
//
// C-22b step 2: the PROCESSED DISPLAY views (undistorted center + magnified
// slice, perspective-wrapped foveae, combined diff/depth) moved OFF the JS event
// loop into the shared `display` vision worker kernel — the registry `onView`
// taps + per-view `frame-worker`s are gone. Main connects the three
// `camera:<serial>` SHM pipes (C-21 gate), spawns the worker with the serialized
// calibration + display params (fovea homographies / depth Q-matrix / slice-
// center, recomputed on each throttled volt/target update), and re-sources
// `capture.onCenterTick` from the worker-posted processed center frame.
// Recording is UNCHANGED — it reads `leases.L/C/R.camera.stream` directly.

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { DisposerBag, publishSerials, releaseLeases } from "@orchestrator/session-resources";
import {
  depthFromInverse,
  ORIGIN_POS,
  radians,
  VOLT_TELEMETRY_INTERVAL_MS,
} from "@orchestrator/fovea-pipeline";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import {
  serializeCalibration,
  type DisplayParams,
  type DisplayValues,
} from "@orchestrator/display-transport";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import { manualControl } from "./contract";
import { createCapture } from "./capture";
import { createRecording } from "./recording";
import { makeMat } from "@lib/mat";
import {
  createQMatrix,
  deriveFoveaIntrinsics,
  inverseTriangulate,
  vergeToDistance,
} from "@lib/stereo";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { RollingStats } from "@lib/util/rolling";

export default function manualControlSession(broker: PipeBroker): ServerSession<typeof manualControl> {
  return defineResourceSession("manual-control", manualControl, (s) => {
    let triple: CalibratedTriple | null = null;
    let loop: ActuationLoop | null = null;
    let worker: VisionWorkerHandle | null = null;

    // Center-frame geometry, learned from the worker's processed center.
    let width = 0;
    let height = 0;

    // Target state — always whatever `steer` last set (no tracker/prediction).
    let target: Point2d = { x: 0, y: 0 };
    let targetAngle: Point2d = { x: 0, y: 0 };
    let distanceOverride: number | null = null;
    let shiftOverride: number | null = null;

    // Latest commanded voltages, mirrored locally for the fovea-wrap homography.
    const volts: { L: Pos; R: Pos } = { L: { ...ORIGIN_POS }, R: { ...ORIGIN_POS } };

    // --- targeting ---------------------------------------------------------

    function baseDistance(): number {
      return vergeToDistance(s.state.verge, s.state.baseline);
    }
    const baseShiftDeg = (): number => s.state.shift;
    const distance = (): number => distanceOverride ?? baseDistance();
    const shiftDeg = (): number => shiftOverride ?? baseShiftDeg();

    function targetVolts(): { l: Pos; r: Pos } {
      if (!triple) return { l: ORIGIN_POS, r: ORIGIN_POS };
      const A = inverseTriangulate(targetAngle, s.state.baseline, distance(), radians(shiftDeg()));
      return { l: triple.conv.A2V.L(A.l), r: triple.conv.A2V.R(A.r) };
    }

    function setTargetFromPixel(px: Point2d): void {
      target = px;
      distanceOverride = null;
      shiftOverride = null;
      targetAngle = triple?.undistort ? triple.undistort.angular([px], false)[0] : { x: 0, y: 0 };
      s.telemetry({ target, target_angle: targetAngle });
      pushParams(sliceAtParam());
    }

    function setTargetFromAngle(angle: Point2d, distance_mm?: number, shift_deg?: number): void {
      targetAngle = angle;
      distanceOverride = distance_mm ?? null;
      shiftOverride = shift_deg ?? null;
      target = triple?.undistort ? triple.undistort.position([angle], false)[0] : { x: 0, y: 0 };
      s.telemetry({ target, target_angle: targetAngle });
      pushParams({ ...sliceAtParam(), ...depthParams() });
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
      const at = undistort ? undistort.position([targetAngle], false)[0] : target;
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

    // --- worker results (publish frames + re-source capture + learn geo) --

    function onResult(r: VisionResult): void {
      const v = r.values as DisplayValues;
      if (v.size) {
        width = v.size.width;
        height = v.size.height;
        s.telemetry({ size: v.size });
      }
      for (const f of r.frames) {
        const mat = makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels);
        // Feed capture BEFORE publishing — `onCenterTick` copies synchronously
        // when a pass is waiting; `s.frame` may transfer/neuter the buffer.
        if (f.name === "C") capture.onCenterTick(mat);
        s.frame(f.name, mat);
      }
    }

    // --- capture (docs/refactor/orchestrator.md roadmap item 6) ----------

    const capture = createCapture({
      getTriple: () => triple,
      volts: () => volts,
      targetAngle: () => targetAngle,
      centerFrameSize: () => ({ width, height }),
      zoom: () => s.state.zoom,
      capStack: () => s.state.cap_stack,
      baseline: () => s.state.baseline,
      wrapEnable: () => s.state.wrap,
      steerToAngle: setTargetFromAngle,
      frame: (name, payload) => s.frame(name, payload),
      telemetry: (patch) => s.telemetry(patch),
    });

    // --- recording (reads leases.L/C/R.camera.stream directly; unchanged) --

    const recording = createRecording({
      getTriple: () => triple,
      volts: () => volts,
      telemetry: (patch) => s.telemetry(patch),
    });

    // --- actuation -----------------------------------------------------

    let lastVoltEmit = 0;
    let lastParamPush = 0;
    const actuateMsStats = new RollingStats(0.9, 2, "ms");

    // --- lifecycle -------------------------------------------------------

    function initParams(): Record<string, unknown> {
      return {
        kind: "display",
        cal: triple?.undistort ? serializeCalibration(triple.undistort.calibration) : null,
        zoom: Math.max(1, s.state.zoom),
        view: s.state.view,
        wrap: s.state.wrap,
        ...voltParams(),
        ...sliceAtParam(),
        ...depthParams(),
      };
    }

    /** Connect a `camera:<serial>` pipe (refcount++ → C-21 gate) → worker input. */
    function connectPipe(role: "L" | "C" | "R", serial: string, ids: string[]): PipeInput {
      const pipeId = `camera:${serial}`;
      const handle = broker.connect(pipeId);
      ids.push(pipeId);
      const { width: w, height: h, channels, bytesPerFrame, maxBytes } = handle.spec;
      return { role, shmName: handle.shmName, width: w, height: h, channels, bytesPerFrame: maxBytes ?? bytesPerFrame };
    }

    // Resource-scoped activation (A-P1). Trickiest teardown in the fleet: a
    // capture/recording pass may still be reading a stream (or awaiting the next
    // center tick via `capture.onCenterTick`) when the last subscriber leaves —
    // it MUST fully drain BEFORE the worker terminates + the pipes disconnect +
    // the leases release. Registration order below is reverse of the drain.
    async function activateSession(scope: ResourceScope): Promise<void> {
      const t = await scope.use(() => acquireTriple(s), releaseLeases); // drains LAST
      if (!t) return;
      triple = t;

      const pipeIds: string[] = [];
      const pipes: PipeInput[] = [
        connectPipe("L", t.leases.L.camera.serial, pipeIds),
        connectPipe("C", t.leases.C.camera.serial, pipeIds),
        connectPipe("R", t.leases.R.camera.serial, pipeIds),
      ];
      const taps = new DisposerBag();
      publishSerials(t.leases, taps, s);
      worker = createVisionWorker({ pipes, params: initParams() }, onResult);

      loop = startActuationLoop({
        targetVolts,
        onVolts(v, actuateMs) {
          volts.L = v.L;
          volts.R = v.R;
          actuateMsStats.push(actuateMs);
          const now = performance.now();
          if (now - lastParamPush >= VOLT_TELEMETRY_INTERVAL_MS) {
            lastParamPush = now;
            pushParams(voltParams());
          }
          if (now - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
            lastVoltEmit = now;
            s.telemetry({
              volt: v,
              perf: { actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max } },
            });
            actuateMsStats.resetMax();
          }
        },
      });

      // --- teardown (registered reverse of drain; LIFO) -----------------
      // The worker + pipes drain AFTER the awaited capture/recording drain, so a
      // capture waiting on the next processed-center tick still receives it (the
      // worker keeps posting — it holds its own Undistort, independent of main's
      // `triple`). Terminate worker BEFORE dropping the gate.
      scope.defer(() => {
        worker?.terminate();
        worker = null;
        for (const id of pipeIds) broker.disconnect(id);
        taps.dispose();
      });
      // The awaited async drain: a capture can be waiting on the next center
      // tick, so this MUST run while the worker is still live.
      scope.defer(async () => {
        await Promise.all([recording.stop(), capture.waitIdle()]);
      });
      // Before the drain: new activity sees "not ready" instead of racing it.
      scope.defer(() => {
        triple = null;
        s.telemetry({ ready: false });
      });
      scope.defer(() => {
        loop?.stop(); // drains FIRST — stop actuating immediately
        loop = null;
      });

      s.telemetry({ ready: true });
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        width = height = 0; // after the full drain (leases already released)
      },
      watch: {
        zoom() {
          pushParams({ zoom: Math.max(1, s.state.zoom), ...voltParams(), ...sliceAtParam() });
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
        async steer(t) {
          if (t.mode === "pixel") setTargetFromPixel(t.value);
          else setTargetFromAngle(t.value, t.distance_mm, t.shift_deg);
        },
        async previewVolts(queries) {
          if (!triple) return queries.map(() => ({ l: ORIGIN_POS, r: ORIGIN_POS }));
          return queries.map(({ value, distance_mm, shift_deg }) => {
            const A = inverseTriangulate(
              value,
              s.state.baseline,
              distance_mm ?? baseDistance(),
              radians(shift_deg ?? baseShiftDeg()),
            );
            return { l: triple!.conv.A2V.L(A.l), r: triple!.conv.A2V.R(A.r) };
          });
        },
        async runCapture({ setpoints }) {
          await capture.run(setpoints);
        },
        async saveCapture({ path, format }) {
          await capture.save(path, format);
        },
        async discardCapture() {
          capture.discard();
        },
        async startRecording({ path }) {
          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
        },
      },
      busy() {
        if (capture.busy) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}
