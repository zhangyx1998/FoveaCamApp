// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disparity-scope session — auto-vergence, re-plumbed per
// docs/proposals/pid-nodes-and-view-replumb.md §"Disparity re-plumb (worker B)".
// This module is the thin main-thread coordinator: it wires up the graph and
// forwards final results, it does not micro-manage frames.
//
//  - on activate: `acquireTriple` (calibration); advertise the THREE undistort
//    pipes the views + the scope kernel source from — C = INTRINSIC undistort
//    (cal from the triple), L/R = HOMOGRAPHY undistort fed `A2H∘V2A(volts)` from
//    the actuation loop's mirror history by a `startHomographyFeeder` (the same
//    seam tracking-single uses); `broker.connect` those pipe ids as the kernel
//    inputs (refcount++ → demand propagation keeps the undistort bricks + their
//    converters awake); spawn the vision worker; create the PID controller NODE
//    (`createPidNode`) and start the fixed-rate `startActuationLoop`.
//  - the worker SHM-reads L/C/R (foveas arrive PRE-WARPED off the homography
//    pipes; C is the undistorted wide view), runs KCF + the tile match, and
//    posts the scope PROJECTION (matched fovea centres + target, undistorted
//    wide pixels) + diagnostic frames. The kernel no longer emits L/C/R view
//    frames — the views source directly from the undistort pipes, so a busy
//    kernel can't cap their fps.
//  - main runs the vergence control law INSIDE the PID node's control fn
//    (`node.step(fn)`): `stepVergence` reads the projection and produces the
//    `{ l, r }` command volts. `startActuationLoop` reads `commandedVolts`
//    synchronously every tick (unchanged cadence).
//
// Pointer drag → the PID node's OVERRIDE slot: engage on down, update on move,
// release on up. The renderer only has a pixel, so the SESSION converts it
// (undistorted wide pixel → ray → both-eye volts) and pins the slot server-side
// (the generic `pidOverride` command exists too, for a caller that already has
// volts). On release the node's `seed` hook reseeds the controllers from the
// LAST override value (velocity-form integrator ⇒ output continuity, no jump) —
// see `seedFromOverride` for the reconstruction inverse. This replaces the old
// kernel `wrapPerspective` + homography-param push (the foveas are pre-warped
// upstream now) and the inline `pids`/`dragging` control path.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { startActuationLoop, type ActuationLoop } from "@orchestrator/actuation";
import { DisposerBag, publishSerials, releaseLeases } from "@orchestrator/session-resources";
import { ORIGIN_POS, radians, VOLT_TELEMETRY_INTERVAL_MS } from "@orchestrator/fovea-pipeline";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import {
  advertiseHomographyUndistortPipe,
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import {
  conversionComputeH,
  startHomographyFeeder,
} from "@orchestrator/homography-feeder";
import { pushHomography } from "core/Aravis";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { registerGraphWiring } from "@orchestrator/graph-topology";
import {
  applyPidOverride,
  createPidNode,
  outputOf,
  type PidNodeHandle,
} from "@orchestrator/pid-node";
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
  type VergenceVolts,
} from "./contract";
import {
  matchMagnification,
  seedVergence,
  stepVergence,
  type ScopeProjection,
  type VergenceControllers,
} from "./vergence";
import type { DisparityParams, DisparityValues } from "./vision";
import { makeMat } from "@lib/mat";
import { PID, PID2D, type PidParams } from "@lib/pid";
import { distanceToVerge, vergeToDistance, vergenceToDistance } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";

const ZERO: Point2d = { x: 0, y: 0 };
const now = () => performance.now();

const SHIFT_LIMIT = radians(SHIFT_LIMIT_DEG);
const VSHIFT_LIMIT = radians(VSHIFT_LIMIT_DEG);
const DT_MAX_FRAMES = 10;
const TRACKER_LOST_TOLERANCE = 10;
// Two matched rays are treated as parallel (verge 0, z → ∞) below this
// tan-difference — guards the seed inverse against a divide-by-~0 on the pure
// drag case (both eyes on the same ray).
const SEED_PARALLEL_EPS = 1e-9;
// Topology-only downstream node id for the pid → controller edge. The actuation
// loop abstracts the MEMS controller (no per-port id reaches the session), so
// this is a stable placeholder the wiring shim renders as a `controller` node.
const CONTROLLER_NODE_ID = "controller";

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
  undistortSeam: UndistortPipeSeam,
): ServerSession<typeof disparity> {
  return defineSession("disparity-scope", disparity, (s) => {
    let triple: CalibratedTriple | null = null;
    const disposers = new DisposerBag();
    let loop: ActuationLoop | null = null;
    let worker: VisionWorkerHandle | null = null;
    // The graph-visible PID controller node (created on activate). Holds the
    // vergence controllers + the renderer-driven override slot.
    let pidNode: PidNodeHandle<VergenceVolts> | null = null;

    let windowStart = now();
    let lastStep = now();
    let lastVoltEmit = 0;
    let status = "initializing";
    // Mirror of the worker's tracker liveness (drives `frozen()` + freeze reset).
    let trackerActive = false;
    let lastGood: Point2d = ZERO;

    // Commanded volts — the PID node's output (control result or pinned
    // override), read synchronously every actuation tick.
    let commandedVolts: VergenceVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
    // The gaze RAY (center-camera angle) a DRAG pinned the eyes at — set on
    // every drag engage, cleared on idle + when the generic (volts-only)
    // override engages. Seeding the release from THIS exact ray (both eyes on
    // it) — instead of recovering the angles from the pinned volts via V2A —
    // is what keeps release continuous: the V2A round-trip is per-eye
    // asymmetric and fabricates a verge/v_shift out of a parallel drag. See
    // `seedVergence`'s SPACE CONTRACT and `seedFromOverride` below.
    let overrideRay: Point2d | null = null;
    const actuateMsStats = new RollingStats(0.9, 2, "ms");

    // The named DOF controllers (owned by the PID node once created). `pan` is a
    // PID2D (separate x/y integrators); `verge`/`v_shift` are scalar PIDs.
    const pan = new PID2D();
    const verge = new PID({
      limits: [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, s.state.baseline)],
    });
    const v_shift = new PID({ limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT] });
    const controllers: VergenceControllers = { pan, verge, v_shift };

    const shiftLim: [number, number] = [-SHIFT_LIMIT, SHIFT_LIMIT];
    function panParams(t: Tuning): PidParams {
      return { kp: t.pan[0], ki: t.pan[1], kd: t.pan[2], limits: shiftLim };
    }
    /** Retune the controllers from tuning (uniform {@link PidParams}) without
     *  disturbing the running integrators — `verge`'s baseline-derived limits
     *  are left intact (setParams only touches limits when passed). */
    function syncGains(t: Tuning): void {
      pan.setParams({ x: panParams(t), y: panParams(t) });
      verge.setParams({ kp: t.depth[0], ki: t.depth[1], kd: t.depth[2] });
      v_shift.setParams({
        kp: t.v_shift[0],
        ki: t.v_shift[1],
        kd: t.v_shift[2],
        limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT],
      });
    }
    syncGains(s.state.tuning);

    /** Calibration-MEASURED fovea↔wide magnification for the match (mean of
     *  the per-eye values when both are measured; a single eye's value when
     *  only one is; null when neither is — the kernel then falls back to the
     *  nominal `state.zoom`, the exact pre-measurement behavior). */
    function measuredMatchZoom(): number | null {
      if (!triple) return null;
      const { L, R } = triple.magnification;
      if (L !== null && R !== null) return (L + R) / 2;
      return L ?? R;
    }

    /** Magnification driving the tile/strip match scale (measured, else the
     *  nominal UI zoom). `state.zoom` itself now drives ONLY the sliced-view
     *  crop + KCF search sizing — see docs/applications/disparity-scope.md. */
    function matchZoom(): number {
      return matchMagnification(measuredMatchZoom(), s.state.zoom);
    }

    function effectiveScale(): number {
      const ratio = Math.max(0, Math.min(1, s.state.tuning.scale));
      return 1 + (matchZoom() - 1) * ratio;
    }

    function frozen(): boolean {
      if (trackerActive) return false; // actively tracking: never freeze
      const t = s.state.tuning.timeout;
      const timeoutMs = t > 0 ? t : Infinity;
      return timeoutMs !== Infinity && now() - windowStart > timeoutMs;
    }

    // --- worker params ----------------------------------------------------

    function sendParams(params: Partial<DisparityParams>): void {
      worker?.sendParams(params as Record<string, unknown>);
    }

    function initParams(): Record<string, unknown> {
      return {
        kind: "disparity",
        kernelW: s.state.kernel.w,
        kernelH: s.state.kernel.h,
        zoom: Math.max(1, s.state.zoom),
        matchZoom: measuredMatchZoom(),
        scale: effectiveScale(),
        target: s.state.target,
        expand_x: s.state.tuning.expand_x,
        expand_y: s.state.tuning.expand_y,
        view: s.state.view,
        lostTolerance: TRACKER_LOST_TOLERANCE,
        trackerInit: s.state.tracker_enabled ? s.state.target : null,
      };
    }

    // --- override slot (renderer drag → pinned output) --------------------

    /** Mirror the server-authoritative override slot into contract state so the
     *  renderer's `usePidOverride` proxy reads `engaged`/`value` back. */
    function publishOverride(): void {
      s.setState(
        "pidOverride",
        pidNode
          ? { engaged: pidNode.override.engaged, value: pidNode.override.value }
          : { engaged: false, value: null },
      );
    }

    /** Pin the override at the volts that aim BOTH foveas along the ray through
     *  the (undistorted wide) pixel `p` — the manual "look here". Same intent as
     *  the pre-replumb drag path, but `p` is now undistorted (the C view reads
     *  the undistort pipe), so lift with distort=false. */
    function engageOverrideAt(p: Point2d): void {
      if (!pidNode || !triple || !triple.undistort) return;
      const ray = triple.conv.P2A.C(p, false);
      const v: VergenceVolts = {
        l: triple.conv.A2V.L(ray),
        r: triple.conv.A2V.R(ray),
      };
      overrideRay = ray; // seed the release from this exact ray, not V2A(v)
      pidNode.override.engage(v);
      commandedVolts = v; // actuation reads this synchronously between results
      status = "manual";
      publishOverride();
    }

    /**
     * Reseed the controllers from the LAST override value so control resumes
     * CONTINUOUSLY (velocity-form integrator ⇒ output = last command = no jump).
     * Invoked by `override.release()`; the reconstruction inverse itself lives
     * in the pure {@link seedVergence} (with its SPACE CONTRACT).
     *
     * The per-eye gaze ANGLES `gL`/`gR` come from ONE of two sources:
     *  - DRAG path — `overrideRay` is set: both eyes were commanded to that
     *    exact ray, so `gL = gR = overrideRay`. `seedVergence` then returns
     *    `verge = v_shift = 0` and `pan = ray − aT` exactly, and the resumed
     *    `A2V(ray)` reproduces the pinned volts. Recovering the angles from the
     *    volts via V2A instead was the release-jump bug: the per-eye V2A
     *    regressions are asymmetric, so a parallel drag came back as `gL ≠ gR`
     *    and fabricated a toe-in (the mirrors jumped to "another location").
     *  - GENERIC volts-only path — `overrideRay` is null: a caller pinned
     *    arbitrary per-eye volts that genuinely encode a vergence, so recover
     *    the angles through V2A (best available; lossy round-trip accepted).
     */
    function seedFromOverride(v: VergenceVolts): void {
      if (!triple || !triple.undistort) return;
      const conv = triple.conv;
      const gL = overrideRay ?? conv.V2A.L(v.l);
      const gR = overrideRay ?? conv.V2A.R(v.r);
      const aT = conv.P2A.C(s.state.target, false);
      const seed = seedVergence(gL, gR, aT, s.state.baseline, SEED_PARALLEL_EPS);
      pan.value = seed.pan; // PID2D setter clamps each axis to its limits
      verge.value = seed.verge; // PID setter clamps to its limits
      v_shift.value = seed.v_shift; // PID setter clamps to its limits
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
      }
      if (v.projection) runControl(v.projection);
    }

    /** The vergence control law, run INSIDE the PID node's control fn — invoked
     *  by `node.step` only when the override is NOT engaged (the node resets the
     *  controllers itself while overridden). Returns the held/last volts on any
     *  hold condition so the actuation output freezes rather than winds down. */
    function controlStep(projection: ScopeProjection): VergenceVolts {
      if (!triple || !triple.undistort) {
        status = "no calibration";
        return commandedVolts;
      }
      if (frozen()) {
        status = "frozen";
        return commandedVolts;
      }
      const t = now();
      const dt = Math.min((t - lastStep) * s.state.tuning.sensitivity, DT_MAX_FRAMES);
      const result = stepVergence(
        projection,
        controllers,
        { P2A: triple.conv.P2A, A2V: triple.conv.A2V },
        { baseline: s.state.baseline, minScore: s.state.tuning.min_score },
        dt,
      );
      if (!result) {
        status = "low score";
        return commandedVolts;
      }
      lastStep = t;
      status = "tracking";
      return { l: result.left, r: result.right };
    }

    function runControl(projection: ScopeProjection): void {
      if (!pidNode) return;
      commandedVolts = outputOf(pidNode.step(() => controlStep(projection)));
      if (pidNode.override.engaged) status = "manual";
    }

    // --- actuation (fixed-rate, decoupled from vision fps) ----------------

    function targetVolts(): { l: Pos; r: Pos } {
      return commandedVolts;
    }

    function onVolts(vv: { L: Pos; R: Pos }, actuateMs: number): void {
      actuateMsStats.push(actuateMs);
      const t = now();
      if (t - lastVoltEmit < VOLT_TELEMETRY_INTERVAL_MS) return;
      lastVoltEmit = t;
      const vergence = triple ? triple.conv.V2A.L(vv.L).x - triple.conv.V2A.R(vv.R).x : 0;
      const realized_distance = vergenceToDistance(vergence, s.state.baseline / 1000);
      const commanded_distance = vergeToDistance(verge.value, s.state.baseline);
      // The per-eye pose overlay draws over the UNDISTORTED wide view now, so
      // project to undistorted pixels (distort=false), matching every other
      // overlay's space (target/tracker/match all undistorted).
      const PX = (role: "L" | "R"): Point2d =>
        triple ? triple.conv.A2P.C(triple.conv.V2A[role](vv[role]), false) : ZERO;
      const readout: PidReadout = {
        verge: verge.value,
        panX: pan.value.x,
        panY: pan.value.y,
        v_shift: v_shift.value,
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

    // Connected pipe ids, in `pipeInputs` order — the graph wiring's edge
    // sources (C-24 stage-1 shim, same pattern as tracking-single).
    let pipeIds: string[] = [];

    /** Connect a pipe by id (refcount++ → C-21 gate) and return its worker
     *  `PipeInput`; registers the matching `disconnect` on `disposers`. */
    function connectCameraPipe(role: "L" | "C" | "R", pipeId: string): PipeInput {
      const handle = broker.connect(pipeId);
      pipeIds.push(pipeId);
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

      // §5 view re-plumb: advertise the three undistort pipes the views + the
      // scope kernel source from. C = INTRINSIC undistort (cal = the SAME
      // record the triple's `undistort` was built from — `triple.undistort`
      // was constructed from it). L/R (mirror-steered) = HOMOGRAPHY undistort,
      // each fed `A2H∘V2A(volts)` from the mirror history by a feeder (an empty
      // ring passes frames through). The PRODUCER teardown is deferred AFTER
      // the consumer `disconnect`s (DisposerBag is FIFO) — retirers are added
      // once the kernel inputs are connected.
      const undistortIds: Record<"L" | "C" | "R", string | null> = {
        L: null,
        C: null,
        R: null,
      };
      const retirers: (() => void)[] = [];
      if (t.undistort) {
        const idC = advertiseUndistortPipe(
          undistortSeam,
          t.leases.C.camera,
          t.undistort.calibration,
        );
        undistortIds.C = idC;
        retirers.push(() => retireUndistortPipe(undistortSeam, idC));
      }
      const computeH = conversionComputeH(t.conv);
      for (const side of ["L", "R"] as const) {
        const pipeId = advertiseHomographyUndistortPipe(
          undistortSeam,
          t.leases[side].camera,
        );
        undistortIds[side] = pipeId;
        const stopFeeder = startHomographyFeeder({
          pipeId,
          side,
          computeH,
          push: pushHomography,
        });
        retirers.push(() => {
          stopFeeder(); // stop pushing BEFORE the brick detaches
          retireUndistortPipe(undistortSeam, pipeId);
        });
      }

      // Kernel inputs = the UNDISTORT pipe ids (demand propagation keeps the
      // undistort bricks + converters awake). C falls back to the raw convert
      // pipe on an uncalibrated wide camera (control then holds "no
      // calibration", the same degradation as before).
      pipeIds = [];
      const pipeInputs: PipeInput[] = [
        connectCameraPipe("L", undistortIds.L ?? nodeId.convert(t.leases.L.camera.serial)),
        connectCameraPipe("C", undistortIds.C ?? nodeId.convert(t.leases.C.camera.serial)),
        connectCameraPipe("R", undistortIds.R ?? nodeId.convert(t.leases.R.camera.serial)),
      ];
      // Now defer the producer teardown (runs AFTER the consumer disconnects).
      for (const retire of retirers) disposers.add(retire);

      const kernelId = nodeId.win("disparity-scope", "disparity");
      const pidId = nodeId.win("disparity-scope", "pid");
      const bgra = { kind: "frame", pixelFormat: "BGRA8", dtype: "U8" } as const;
      // meterName = the kernel node id, so the worker's self-meter folds onto
      // this node's badge (rig 2026-07-08: the kernel was the 35-vs-60fps
      // limiter, invisible until it showed as a node).
      worker = createVisionWorker(
        { pipes: pipeInputs, params: initParams(), meterName: kernelId },
        onResult,
      );
      disposers.add(
        registerGraphWiring({
          nodes: [
            {
              id: kernelId,
              kind: "disparity",
              owner: "win/disparity-scope",
              output: bgra,
              transport: "port",
            },
          ],
          edges: pipeInputs.map((p, i) => ({
            from: pipeIds[i]!,
            to: kernelId,
            port: p.role,
            type: bgra,
          })),
        }),
      );

      // The PID controller node: scope → pid (input edge) + pid → controller
      // (output edge, filed on the controller node by the wiring shim).
      // `createPidNode` owns its own graph registration; dispose retires it.
      pidNode = createPidNode<VergenceVolts>({
        id: pidId,
        kind: "pid",
        owner: "win/disparity-scope",
        inputs: [{ from: kernelId, port: "projection" }],
        outputs: [{ to: CONTROLLER_NODE_ID, port: "volt" }],
        controllers: { pan, verge, v_shift },
        seed: seedFromOverride,
      });
      disposers.add(() => {
        pidNode?.dispose();
        pidNode = null;
      });

      loop = startActuationLoop({ targetVolts, onVolts });
      // Surface the measured magnification (null = nominal-zoom fallback) so
      // the UI can display the actual match scale instead of guessing from
      // the (now crop-only) zoom knob.
      s.telemetry({ ready: true, match_magnification: measuredMatchZoom() });
    }

    function idleSession(): void {
      loop?.stop();
      loop = null;
      worker?.terminate(); // terminate before disconnect: no reads after the gate drops
      worker = null;
      trackerActive = false;
      disposers.dispose(); // disconnect pipes, stop feeders, retire undistort, dispose pid node
      publishOverride(); // pidNode is now null → released state
      releaseLeases(triple);
      triple = null;
      status = "initializing";
      commandedVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
      overrideRay = null;
      s.resetTelemetry(["ready", "status", "tracker_bbox", "match_magnification"]);
    }

    return {
      commands: {
        async pointer({ p, buttons: _buttons, phase }) {
          if (phase === "down") {
            trackerActive = false;
            sendParams({ trackerRelease: true, target: p });
            s.telemetry({ tracker_bbox: null });
          }
          if (phase !== "up") {
            s.setState("target", p);
            sendParams({ target: p });
            engageOverrideAt(p); // pin the override at the dragged ray (engage/update)
          } else {
            pidNode?.override.release(); // seeds the controllers → continuity
            publishOverride();
            windowStart = now();
            if (s.state.tracker_enabled) sendParams({ trackerInit: s.state.target });
          }
        },
        async resetTuning() {
          s.setState("tuning", cloneTuning(DEFAULT_TUNING));
        },
        async reset_vergence() {
          pan.reset();
          verge.reset();
          v_shift.reset();
        },
        async setPid({ dof, value }) {
          switch (dof) {
            case "verge":
              verge.value = value;
              break;
            case "v_shift":
              v_shift.value = value;
              break;
            case "panX":
              pan.x.value = value;
              break;
            case "panY":
              pan.y.value = value;
              break;
          }
        },
        async pidOverride(command) {
          if (!pidNode) return;
          // A volts-only engage: no known gaze ray, so the release must recover
          // the angles via V2A. Drop any stale drag ray so it isn't misused.
          if ("value" in command) overrideRay = null;
          const state = applyPidOverride(pidNode.override, command);
          if (state.engaged && state.value) {
            commandedVolts = state.value;
            status = "manual";
          } else if (!state.engaged) {
            windowStart = now(); // released via the generic path → restart freeze window
          }
          s.setState("pidOverride", state);
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
          verge.limits = [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, v)];
        },
        zoom() {
          sendParams({ zoom: Math.max(1, s.state.zoom), scale: effectiveScale() });
        },
        view(view) {
          sendParams({ view });
        },
        kernel(k) {
          sendParams({ kernelW: k.w, kernelH: k.h });
        },
        tracker_enabled(on) {
          if (!on) {
            trackerActive = false;
            sendParams({ trackerRelease: true });
            s.telemetry({ tracker_bbox: null });
          } else if (!pidNode?.override.engaged) {
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
