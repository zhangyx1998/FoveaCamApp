// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Manual-control session — a calibrated L/C/R triple + timer-paced actuation
// with no KCF tracker: the target is
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
import { controllerNode, startPacer, type PositionInput } from "@orchestrator/controller-node";
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
  advertiseHomographyUndistortPipe,
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import { conversionComputeH, startHomographyFeeder } from "@orchestrator/homography-feeder";
import { pushHomography } from "core/Aravis";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeBroker } from "@orchestrator/pipe-session";
import { createRawPipe, type RawPipeSeam, type RawHandle } from "@orchestrator/raw-pipe";
import {
  createCaptureNode,
  type CaptureNodeHandle,
  type CaptureShot,
  type CaptureStreamInit,
} from "@orchestrator/capture-node";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import { manualControl } from "./contract";
import { createRecording } from "./recording";
import { makeMat, matToArray } from "@lib/mat";
import {
  createQMatrix,
  deriveFoveaIntrinsics,
  inverseTriangulate,
  vergeToDistance,
} from "@lib/stereo";
import { RECT } from "@lib/util/geometry";
import { pixelFormatChannels, pixelFormatDtype, significantBits } from "@lib/util/dtype";
import type { PixelFormat } from "core/Aravis";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { RollingStats } from "@lib/util/rolling";

export default function manualControlSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  rawSeam: RawPipeSeam,
): ServerSession<typeof manualControl> {
  return defineResourceSession("manual-control", manualControl, (s) => {
    let triple: CalibratedTriple | null = null;
    let posInput: PositionInput | null = null;
    let stopActuation: (() => void) | null = null;
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

    // --- capture NODE (capture-recorder-nodes Phase 3) --------------------
    // The stack/wrap/diff/slice math moved OFF the main JS loop into a worker
    // thread (`@orchestrator/capture-node`) that holds the full-depth resources.
    // Main only computes the ruling-3 `onCaptureStart` metadata snapshot (from
    // the calibrated triple), brokers the ON-DEMAND raw-pipe connect per shot,
    // and republishes the node's resource manifest as `capture_meta`.
    let captureNode: CaptureNodeHandle | null = null;
    let activeCapture: Promise<void> = Promise.resolve();
    let capturing = false;

    /** Raw-pipe geometry for a camera (its ACTUAL sensor readout format+dims). */
    function rawGeometryFor(camera: {
      pixel_format: PixelFormat;
      getFeatureInt(name: string): number;
    }) {
      const format = camera.pixel_format;
      const dtype = pixelFormatDtype(format);
      return {
        width: camera.getFeatureInt("Width"),
        height: camera.getFeatureInt("Height"),
        channels: pixelFormatChannels(format),
        bytesPerElement: dtype === "U16" ? 2 : 1,
        pixelFormat: format,
        ringDepth: 8, // a short burst; a deep recorder ring isn't needed
      };
    }

    /** One connected raw stream → the worker's per-stream init. */
    function streamInitFrom(conn: {
      shmName: string;
      spec: {
        pixelFormat: string;
        dtype: string;
        channels: number;
        bytesPerFrame: number;
        maxBytes?: number;
      };
    }): CaptureStreamInit {
      return {
        shmName: conn.shmName,
        maxBytes: conn.spec.maxBytes ?? conn.spec.bytesPerFrame,
        channels: conn.spec.channels,
        bytesPerElement: conn.spec.dtype === "U16" ? 2 : 1,
        significantBits: significantBits(conn.spec.pixelFormat as PixelFormat),
        pixelFormat: conn.spec.pixelFormat,
      };
    }

    /** ON-DEMAND per-shot connect (capture-node `AcquireStreams`): advertise +
     *  attach the raw L/R producers (gate fires → capture-thread subscriber),
     *  connect all three streams; `release` disconnects + retires them (gate
     *  parks the subscriber → zero capture-thread cost while idle). Center rides
     *  the session's already-connected undistort pipe. */
    function acquireCaptureStreams() {
      if (!triple || !centerPipe) throw new Error("capture: session not active");
      const { L, R } = triple.leases;
      const rawL: RawHandle = createRawPipe(
        rawSeam,
        L.camera,
        `camera/${L.camera.serial}/raw`,
        rawGeometryFor(L.camera),
      );
      const rawR: RawHandle = createRawPipe(
        rawSeam,
        R.camera,
        `camera/${R.camera.serial}/raw`,
        rawGeometryFor(R.camera),
      );
      const cL = broker.connect(rawL.pipeId);
      const cR = broker.connect(rawR.pipeId);
      return {
        streams: {
          left: streamInitFrom(cL),
          right: streamInitFrom(cR),
          center: {
            shmName: centerPipe.shmName,
            maxBytes: centerPipe.maxBytes,
            channels: centerPipe.channels,
          },
        },
        release: () => {
          broker.disconnect(rawL.pipeId);
          broker.disconnect(rawR.pipeId);
          rawL.retire();
          rawR.retire();
        },
      };
    }

    /** Ruling-3 `onCaptureStart` snapshot: the calibration-derived transforms +
     *  per-resource metadata for the WHOLE shot (regardless of stack depth).
     *  Ported faithfully from the deleted `capture.ts` captureOnce/runInner. */
    function captureSnapshot(reset: boolean, indexed: boolean): CaptureShot {
      const und = triple!.undistort!;
      const { conv } = triple!;
      const zoom = Math.max(1, s.state.zoom);
      const baseline = s.state.baseline;
      const A = { L: conv.V2A.L(volts.L), R: conv.V2A.R(volts.R) };
      const intrinsics = {
        L: deriveFoveaIntrinsics(und, A.L, zoom),
        R: deriveFoveaIntrinsics(und, A.R, zoom),
      };
      const Q = createQMatrix(intrinsics.L, intrinsics.R, baseline);
      const HL = conv.A2H.L(A.L);
      const HR = conv.A2H.R(A.R);
      const size = { width: width / zoom, height: height / zoom };
      const at = und.position([targetAngle], false)[0]!;
      const rect = RECT.fromCenter(at, size);
      const sensor_size = und.sensor_size;
      return {
        reset,
        indexed,
        stackCount: s.state.cap_stack,
        H_L: Array.from(HL as unknown as Float64Array),
        H_R: Array.from(HR as unknown as Float64Array),
        rect,
        meta: {
          wide: reset
            ? { sensor_size, focal: und.focal, center: und.center, fov: und.fov }
            : undefined,
          fovea: { Q: matToArray(Q), baseline, "baseline.unit": "millimeter" },
          left: {
            sensor_size,
            volt: volts.L,
            "volt.unit": "volt",
            angle: A.L,
            "angle.unit": "radian",
            intrinsics: intrinsics.L,
          },
          right: {
            sensor_size,
            volt: volts.R,
            "volt.unit": "volt",
            angle: A.R,
            "angle.unit": "radian",
            intrinsics: intrinsics.R,
          },
        },
      } as CaptureShot;
    }

    // --- recording (reads leases.L/C/R.camera.stream directly; unchanged) --

    const recording = createRecording({
      getTriple: () => triple,
      volts: () => volts,
      rawSeam,
      // Connect a raw pipe for the recorder node (refcount++ → C-21 gate →
      // producer runs); the node releases it on stop.
      connect: (pipeId) => {
        const handle = broker.connect(pipeId);
        return {
          shmName: handle.shmName,
          spec: handle.spec,
          release: () => void broker.disconnect(pipeId),
        };
      },
      // Notify main so the viewer window auto-opens the finished `.fovea`.
      finished: (foveaPath) =>
        process.parentPort?.postMessage({ type: "recording:finished", path: foveaPath }),
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

      // Unified-topology §5 (real-2b): the mirror-steered L/R cameras get
      // HOMOGRAPHY undistort bricks chained on their shared converters, each fed
      // H(mirrorAt(t)) at ~200 Hz from the actuation loop's mirror history
      // (v1 derivation: the display path's A2H∘V2A — see homography-feeder). The
      // RENDERER binds these for the L/R main views (always undistorted — the
      // retired `wrap` toggle's warp, now native + pose-tracked). Consumer-gated
      // like every pipe; an empty ring passes frames through untouched. The
      // kernel keeps consuming the raw CONVERT L/R inputs (below) — its
      // diff/depth `aligned` composite still wraps them via the pushed H.
      const computeH = conversionComputeH(t.conv);
      for (const side of ["L", "R"] as const) {
        const pipeId = advertiseHomographyUndistortPipe(undistortSeam, t.leases[side].camera);
        const stopFeeder = startHomographyFeeder({
          pipeId,
          side,
          computeH,
          push: pushHomography,
        });
        scope.defer(() => {
          stopFeeder(); // stop pushing BEFORE the brick detaches
          retireUndistortPipe(undistortSeam, pipeId);
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
      worker = createVisionWorker(
        // meterName: the display kernel shows up in perfSnapshot.workloads
        // (worker self-meter) even before this app gets full graph wiring.
        { pipes, params: initParams(), meterName: nodeId.win("manual-control", "display") },
        onResult,
      );

      // Capture node (idle until `capture()`): graph row + worker; the raw L/R
      // producers are advertised/connected ON DEMAND per shot (acquireStreams).
      captureNode = createCaptureNode({
        id: nodeId.win("manual-control", "capture"),
        graphInputs: {
          left: `camera/${t.leases.L.camera.serial}/raw`,
          right: `camera/${t.leases.R.camera.serial}/raw`,
          center: undistortC ?? nodeId.convert(t.leases.C.camera.serial),
        },
        acquireStreams: acquireCaptureStreams,
      });

      // Push model (controller-node-and-fifo-edges §3): the SESSION owns the
      // 1 ms cadence; each tick pushes the current target and uses the node's
      // synchronous predicted-volts return for the local mirror + telemetry
      // (was `onVolts`). `onApplied` supplies the awaited round-trip ms on the v1
      // fallback (~0 on the v2 streaming path).
      let lastActuateMs = 0;
      posInput = controllerNode().openPosition("manual-control", {
        from: nodeId.win("manual-control", "display"),
        initial: { left: { ...volts.L }, right: { ...volts.R } },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      stopActuation = startPacer(1, () => {
        const t = targetVolts();
        const p = posInput!.update({ left: t.l, right: t.r });
        const v = { L: p.left, R: p.right };
        volts.L = p.left;
        volts.R = p.right;
        actuateMsStats.push(lastActuateMs);
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
      // The awaited async drain: a capture in flight must finish (its raw pipes
      // release) before the vision worker + pipes tear down; then stop the
      // capture node's own worker.
      scope.defer(async () => {
        await Promise.all([recording.stop(), activeCapture]);
        await captureNode?.stop();
        captureNode = null;
      });
      // Before the drain: new activity sees "not ready" instead of racing it.
      scope.defer(() => {
        triple = null;
        s.telemetry({ ready: false });
      });
      scope.defer(() => {
        stopActuation?.(); // drains FIRST — stop pushing immediately
        stopActuation = null;
        void posInput?.close(); // terminate the MCU stream + disable-iff-we-enabled
        posInput = null;
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
        async capture({ tag }) {
          if (!triple?.undistort || !captureNode) throw new Error("Capture not ready");
          // `tag` absent OR 0 starts a fresh accumulation (clear + provide
          // "wide"); a present tag accumulates an indexed resource (raster).
          const reset = tag === undefined || tag === 0;
          const indexed = tag !== undefined;
          const shot = captureSnapshot(reset, indexed);
          capturing = true;
          s.telemetry({ captureBusy: true });
          activeCapture = captureNode
            .capture(shot)
            .then((manifest) => {
              s.telemetry({ capture_meta: manifest });
            })
            .finally(() => {
              capturing = false;
              s.telemetry({ captureBusy: false });
            });
          await activeCapture;
        },
        async getPreview({ resource, index }) {
          return captureNode ? captureNode.getPreview(resource, index) : null;
        },
        async saveCapture({ path, format }) {
          await captureNode?.save(path, format);
          s.telemetry({ capture_meta: {} });
        },
        async discardCapture() {
          await captureNode?.discard();
          s.telemetry({ capture_meta: {} });
        },
        async startRecording({ path }) {
          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
        },
      },
      busy() {
        if (capturing) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}
