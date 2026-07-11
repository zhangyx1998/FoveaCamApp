// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Manual-control session — a calibrated L/C/R triple + timer-paced actuation
// with NO KCF tracker; the target is always whatever `steer` last set. A thin
// coordinator over the shared display worker + controller node. Behavior spec:
// docs/spec/manual-control.md.

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { registerGraphWiring } from "@orchestrator/graph-topology";
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
import { type RawPipeRegistry } from "@orchestrator/raw-pipe";
import { type CaptureShot } from "@orchestrator/capture-node";
import { createCaptureHelper, type CaptureHelper } from "@orchestrator/capture-helper";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import { manualControl } from "./contract";
import { createRecording } from "./recording";
import { slewStep, type SlewPair } from "./slew";
import { type SplitVolts, unifiedSplit, resolveVolts, splitFlags } from "./split";
import { makeMat, matToArray } from "@lib/mat";
import {
  createQMatrix,
  deriveFoveaIntrinsics,
  inverseTriangulate,
  vergeToDistance,
} from "@lib/stereo";
import { RECT } from "@lib/util/geometry";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { RollingStats } from "@lib/util/rolling";

export default function manualControlSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  rawPipes: RawPipeRegistry,
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

    // Per-eye "split" volt overrides (spec §split): null = follows the unified
    // solution; a PosView drag pins it (override > unified). Any steer reunifies.
    const splitVolts: SplitVolts = unifiedSplit();

    function reunify(): void {
      splitVolts.l = null;
      splitVolts.r = null;
    }

    function publishSplit(): void {
      s.telemetry({ split: splitFlags(splitVolts) });
    }

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
      const unified = { l: triple.conv.A2V.L(A.l), r: triple.conv.A2V.R(A.r) };
      return resolveVolts(unified, splitVolts); // override > unified (spec §split)
    }

    function setTargetFromPixel(px: Point2d): void {
      reunify(); // any target set reunifies (spec §targeting)
      publishSplit();
      target = px;
      distanceOverride = null;
      shiftOverride = null;
      targetAngle = triple?.undistort ? triple.undistort.angular([px], false)[0] : { x: 0, y: 0 };
      s.telemetry({ target, target_angle: targetAngle });
      pushParams(sliceAtParam());
    }

    function setTargetFromAngle(angle: Point2d, distance_mm?: number, shift_deg?: number): void {
      reunify(); // programmatic target set reunifies (same rule as a wide drag)
      publishSplit();
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

    // The center pipe the vision worker consumes — capture's one-shot read rides
    // it; stays connected the whole active span so the producer is live.
    let centerPipe: { shmName: string; maxBytes: number; channels: number } | null = null;

    // Capture NODE via the shared helper (spec §capture) — manual-control is a
    // CONSUMER supplying its triple snapshot; built during activation (null until then).
    let captureHelper: CaptureHelper | null = null;

    /** The capture shot's calibration-derived transforms + per-resource metadata
     *  (spec §capture). */
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
      rawPipes,
      // Connect a raw pipe for the recorder node (refcount++ → C-21 gate);
      // inject the JS-side significantBits the native spec drops (ruling 8).
      connect: (pipeId) => {
        const handle = broker.connect(pipeId);
        const injected = rawPipes.specOf(pipeId);
        return {
          shmName: handle.shmName,
          spec: injected
            ? { ...handle.spec, significantBits: injected.significantBits }
            : handle.spec,
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

    // Resource-scoped activation (spec §teardown): an in-flight capture/recording
    // MUST drain before the worker terminates + pipes disconnect + leases release,
    // so defers below are registered in REVERSE of the drain (LIFO).
    async function activateSession(scope: ResourceScope): Promise<void> {
      // Progress monitor: an early-return leaves the list FROZEN at its step;
      // idle teardown clears a cancelled spin-up.
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing cameras" },
        { id: "pipes", label: "Building undistort pipes" },
        { id: "worker", label: "Starting display worker" },
        { id: "capture", label: "Preparing capture" },
        { id: "controller", label: "Wiring controller" },
      ]);
      monitor.start("lease");
      const t = await scope.use(() => acquireTriple(s), releaseLeases); // drains LAST
      if (!t) return; // frozen at "Leasing cameras" (contention/fail)
      monitor.done("lease");
      triple = t;
      // DISPLAY-ONLY: label the leased triple by role (L/C/R) in the profiler.
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

      // Advertise the center `undistort:<serial>` pipe (spec §views). Registered
      // before the worker's defer → retires AFTER consumers disconnect (LIFO).
      monitor.start("pipes");
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

      // L/R mirror-steered HOMOGRAPHY undistort bricks, fed H(mirrorAt(t)) at
      // ~200 Hz — the renderer binds these for the L/R main views (spec §views).
      // The kernel keeps consuming the raw CONVERT L/R inputs below.
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
      monitor.done("pipes");

      monitor.start("worker");
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
        // meterName: the display kernel self-meters into perfSnapshot.workloads.
        { pipes, params: initParams(), meterName: nodeId.win("manual-control", "display") },
        onResult,
      );
      monitor.done("worker");

      monitor.start("capture");
      // Capture node via the shared helper, idle until `captureShot()` (spec
      // §capture): raw L/R producers advertised/connected ON DEMAND per shot.
      captureHelper = createCaptureHelper({
        id: nodeId.win("manual-control", "capture"),
        broker,
        rawPipes,
        graphInputs: {
          left: `camera/${t.leases.L.camera.serial}/raw`,
          right: `camera/${t.leases.R.camera.serial}/raw`,
          center: undistortC ?? nodeId.convert(t.leases.C.camera.serial),
        },
        cameras: () =>
          triple ? { left: triple.leases.L.camera, right: triple.leases.R.camera } : null,
        centerPipe: () => centerPipe,
        // Full fovea snapshot (undistort required) — null → "Capture not ready".
        snapshot: (reset, indexed) =>
          triple?.undistort ? captureSnapshot(reset, indexed) : null,
        recordingActive: () => recording.active,
        telemetry: (patch) => s.telemetry(patch),
      });
      captureHelper.build();
      monitor.done("capture");

      monitor.start("controller");
      // Push model (spec §actuation): the SESSION owns the 1 ms cadence; each
      // tick pushes the current target, using the node's synchronous
      // predicted-volts return for the local mirror + telemetry.
      let lastActuateMs = 0;
      posInput = controllerNode().openPosition("manual-control", {
        from: nodeId.win("manual-control", "display"),
        initial: { left: { ...volts.L }, right: { ...volts.R } },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      // Drag slew (spec §drag-slew): slew the commanded pose toward the target so
      // each tick is a distinct pose the gate passes, then epsilon-snap + go quiet.
      let commanded: SlewPair | null = null;
      let lastPaceAt = 0;
      stopActuation = startPacer(1, () => {
        const target = targetVolts();
        const now = performance.now();
        const dt = lastPaceAt > 0 ? now - lastPaceAt : 1;
        lastPaceAt = now;
        // First tick (or post-reset): command the target directly (no swoop).
        const t = commanded
          ? slewStep(commanded, target, dt).pose
          : { l: { ...target.l }, r: { ...target.r } };
        commanded = t;
        const p = posInput!.update({ left: t.l, right: t.r });
        const v = { L: p.left, R: p.right };
        volts.L = p.left;
        volts.R = p.right;
        actuateMsStats.push(lastActuateMs);
        if (now - lastParamPush >= VOLT_TELEMETRY_INTERVAL_MS) {
          lastParamPush = now;
          pushParams(voltParams());
        }
        if (now - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
          lastVoltEmit = now;
          // Per-eye pose footprint from the ACTUAL commanded volts so the boxes
          // diverge while split; DEGRADE {0,0} uncalibrated (A2P.C throws — spec §split).
          const PX = (role: "L" | "R"): Point2d =>
            triple?.undistort ? triple.conv.A2P.C(triple.conv.V2A[role](v[role]), false) : { x: 0, y: 0 };
          s.telemetry({
            volt: v,
            L_PX: PX("L"),
            R_PX: PX("R"),
            perf: { actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max } },
          });
          actuateMsStats.resetMax();
        }
      });

      // --- teardown (LIFO — reverse of drain; spec §teardown) -----------
      // Worker + pipes drain AFTER the awaited capture/recording drain. Terminate
      // the worker BEFORE dropping the gate.
      scope.defer(() => {
        worker?.terminate();
        worker = null;
        for (const id of pipeIds) broker.disconnect(id);
        taps.dispose();
      });
      // Awaited async drain: an in-flight capture must finish (raw pipes release)
      // before the worker + pipes tear down, then stop the capture node's worker.
      scope.defer(async () => {
        await Promise.all([recording.stop(), captureHelper?.activeCapture ?? Promise.resolve()]);
        await captureHelper?.stop();
        captureHelper = null;
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

      monitor.done("controller");
      s.telemetry({ ready: true });
      monitor.complete(); // spin-up finished — clear the overlay
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        width = height = 0; // after the full drain (leases already released)
        reunify(); // split is session-local — re-entry starts unified
        // Reset stale split/pose telemetry so a re-entry doesn't light the ⟂
        // badge for an actually-unified session.
        s.resetTelemetry(["split", "L_PX", "R_PX"]);
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
        async splitEye({ side, volt }) {
          // Pin one eye to the dragged volt, held until any `steer` reunifies
          // (spec §split; the release keeps the pin).
          splitVolts[side] = { ...volt };
          publishSplit();
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
        // Legacy `capture`/`getPreview` + the mixin `captureShot`/
        // `getCapturePreview` all forward to the helper (guards live inside it).
        async capture({ tag }) {
          if (!captureHelper) throw new Error("Capture not ready");
          await captureHelper.captureShot(tag);
        },
        async captureShot({ tag }) {
          if (!captureHelper) throw new Error("Capture not ready");
          await captureHelper.captureShot(tag);
        },
        async getPreview({ resource, index }) {
          return captureHelper ? captureHelper.getPreview(resource, index) : null;
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
          // Exclusivity (spec §capture): refuse a recording while a capture shot
          // holds the raw L/R pipes.
          if (captureHelper?.capturing) return false;
          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
        },
      },
      busy() {
        if (captureHelper?.capturing) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}
