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
// Capture and recording (docs/history/refactor/orchestrator.md roadmap item 6) are
// wired in separately — see `capture.ts`/`recording.ts`.
//
// C-22b step 2: the PROCESSED DISPLAY views (magnified slice, perspective-
// wrapped foveae, combined diff/depth) run OFF the JS event loop in the shared
// `display` vision worker kernel — the registry `onView` taps + per-view
// `frame-worker`s are gone. real-1g (C-23): the session advertises the
// first-class `undistort:<serial>` center pipe (B's native remap producer);
// the renderer binds it for the wide view, the worker consumes it as its C
// input (calibration-free — main ships fovea homographies / depth Q-matrix /
// slice-center, recomputed on each throttled volt/target update), and
// capture's center reads it as a one-shot on-demand SHM read (ruled Q2).
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
import type { DisplayParams, DisplayValues } from "@orchestrator/display-transport";
import {
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import { readNextPipeFrame } from "@orchestrator/pipe-read-once";
import { nodeId } from "@lib/orchestrator/graph-contract";
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

export default function manualControlSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
): ServerSession<typeof manualControl> {
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
        s.frame(f.name, makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels));
      }
    }

    // --- capture (docs/history/refactor/orchestrator.md roadmap item 6) ----------

    // The center pipe the vision worker consumes (undistort:<serial>, or the
    // raw fallback) — capture's one-shot read rides this segment; it stays
    // connected for the session's whole active span, so the producer is live.
    let centerPipe: { shmName: string; maxBytes: number; channels: number } | null = null;

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
      // C-23 ruled Q2: the NEXT undistorted center via a one-shot SHM read of
      // the already-connected pipe (on-demand, user-initiated — not per-frame).
      readCenter: () =>
        centerPipe
          ? readNextPipeFrame(centerPipe.shmName, centerPipe.maxBytes, centerPipe.channels)
          : Promise.resolve(null),
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

    // Resource-scoped activation (A-P1). Trickiest teardown in the fleet: a
    // capture/recording pass may still be reading a stream (or awaiting a
    // one-shot center-pipe read) when the last subscriber leaves — it MUST
    // fully drain BEFORE the worker terminates + the pipes disconnect + the
    // leases release. Registration order below is reverse of the drain.
    async function activateSession(scope: ResourceScope): Promise<void> {
      const t = await scope.use(() => acquireTriple(s), releaseLeases); // drains LAST
      if (!t) return;
      triple = t;

      // real-1g (C-23): advertise the first-class `undistort:<serial>` center
      // pipe; the renderer binds it for the wide view, the worker consumes it
      // for slice, and capture's one-shot read rides it. Registered before the
      // worker's defer → retires AFTER consumers disconnect (LIFO).
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
      const centerInput = connectPipe(
        "C",
        undistortC ?? nodeId.convert(t.leases.C.camera.serial),
        pipeIds,
      );
      centerPipe = {
        shmName: centerInput.shmName,
        maxBytes: centerInput.bytesPerFrame,
        channels: centerInput.channels,
      };
      scope.defer(() => {
        centerPipe = null;
      });
      const pipes: PipeInput[] = [
        connectPipe("L", nodeId.convert(t.leases.L.camera.serial), pipeIds),
        centerInput,
        connectPipe("R", nodeId.convert(t.leases.R.camera.serial), pipeIds),
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
