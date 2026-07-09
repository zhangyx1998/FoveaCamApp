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
//    the controller node's mirror history by a `startHomographyFeeder`;
//    `broker.connect` those pipe ids as the kernel inputs (refcount++ → demand
//    propagation keeps the undistort bricks + their converters awake); spawn
//    the vision worker; create the PID controller NODE (`createPidNode`) and
//    open a position input on the controller node (push-model transport).
//  - the worker SHM-reads L/C/R (foveas arrive PRE-WARPED off the homography
//    pipes; C is the undistorted wide view), runs the tile match, and posts
//    the scope PROJECTION (matched fovea centres + target, undistorted wide
//    pixels, + the tracker-override flag) + diagnostic frames. The kernel no
//    longer emits L/C/R view frames — the views source directly from the
//    undistort pipes, so a busy kernel can't cap their fps.
//  - the KCF auto-follow runs on its OWN native thread (controller-node-and-
//    fifo-edges §3.5): `createChainedTracker` on the C undistort brick's
//    OwnedFrame tap (latest-wins), so it tracks exactly what the matcher sees
//    and tracking latency never rides the matching budget. The session
//    consumes its results (`tracker-feed.ts`) and forwards each scalar center
//    to the kernel as the `target` param + the `overridden` flag.
//  - main runs the vergence control law INSIDE the PID node's control fn
//    (`node.step(fn)`): `stepVergence` reads the projection and produces the
//    `{ l, r }` command volts, PUSHED to the controller NODE's position input
//    at the projection/PID result rate (controller-node-and-fifo-edges §3 —
//    the MCU stream holds position between updates; the generic `pidOverride`
//    command pushes its pinned volts immediately on engage).
//
// Pointer drag → the TRACKER's override (§3.5, supersedes the PID-slot drag
// path in this app): down/move call `tk.override(p)`; the tracker emits
// `{overridden: true, center: p}` results every frame, the flag rides the
// kernel target push → `projection.overridden` → the PID step — WHICH KEEPS
// RUNNING throughout, steering the foveas to converge on the (moving) dragged
// tile. On release the tracker RE-ARMS at the drag end and the PID simply
// continues — no seed reconstruction on this path (the release-jump class dies
// structurally). The PID node's own override slot stays for the generic
// `pidOverride` command (a programmatic caller that already has volts); its
// seeded release (`seedFromOverride`) now serves only that path.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { controllerNode, type PositionInput } from "@orchestrator/controller-node";
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
import { consumeTracker, createDisparityTrackerFeed } from "./tracker-feed";
import { makeMat } from "@lib/mat";
import { PID, PID2D, type PidParams } from "@lib/pid";
import { distanceToVerge, vergeToDistance, vergenceToDistance } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";
import { RECT } from "@lib/util/geometry";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
// Direct core import in a session — same precedent as tracking-single's
// `createTracker`; all PURE logic lives in tracker-feed.ts/vergence.ts so
// vitest never loads the native addon.
import { createChainedTracker, type KcfTracker, type TrackerMeter } from "core/Tracker";
import { registerNativeProbe } from "@orchestrator/native-probes";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";

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

// Adapt the native tracker meter to the `WorkloadSnapshot` shape
// `perfSnapshot.workloads` uses (same adapter tracking-single carries) —
// keyed by the kcf NODE id so the meter folds onto the graph node's badge.
function trackerWorkload(name: string, m: TrackerMeter): WorkloadSnapshot {
  const t = Date.now();
  return {
    name,
    window: { startedAt: t - m.uptimeMs, snapshotAt: t, uptimeMs: m.uptimeMs },
    utilization: m.utilization,
    busyMs: m.busyMs,
    inputs: m.inputs,
    outputs: m.outputs,
    drops: { total: m.dropTotal, ratePerSec: 0, byReason: {} },
  };
}

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
    // The controller node's position input (push-model device transport,
    // controller-node-and-fifo-edges §3) — opened on activate, closed on idle.
    let posInput: PositionInput | null = null;
    // v1 awaited-actuate round-trip ms (node `onApplied`); ~0 on v2 streaming.
    let lastActuateMs = 0;
    let worker: VisionWorkerHandle | null = null;
    // The graph-visible PID controller node (created on activate). Holds the
    // vergence controllers + the renderer-driven override slot.
    let pidNode: PidNodeHandle<VergenceVolts> | null = null;

    let windowStart = now();
    let lastStep = now();
    let lastVoltEmit = 0;
    let status = "initializing";
    let lastGood: Point2d = ZERO;

    // --- chained tracker state (§3.5) ---
    // The session-owned KCF thread on the C undistort chain (created on
    // activate, released on drain).
    let tk: KcfTracker | null = null;
    // JS-side auto-follow gate: native has NO disarm (same as tracking-single),
    // so a "released" tracker keeps emitting results and this gate ignores
    // them until the next arm.
    let trackerArmed = false;
    // Found results currently flowing (drives `frozen()` + the bbox overlay).
    let trackerActive = false;
    // A pointer drag is in flight (down..up) — the tracker override is engaged.
    let dragging = false;
    // Last `overridden` telemetry sent (publish transitions only, not every
    // tracker result).
    let overriddenTele = false;

    // Commanded volts — the PID node's output (control result or pinned
    // override), pushed to the controller node on every result (`pushVolts`).
    let commandedVolts: VergenceVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
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
      // No tracker knobs (§3.5): the kernel runs no KCF — the session pushes
      // the chained tracker's output as `target`/`overridden` at result rate.
      return {
        kind: "disparity",
        zoom: Math.max(1, s.state.zoom),
        matchZoom: measuredMatchZoom(),
        scale: effectiveScale(),
        target: s.state.target,
        overridden: false,
        expand_x: s.state.tuning.expand_x,
        expand_y: s.state.tuning.expand_y,
        view: s.state.view,
      };
    }

    // --- chained tracker (§3.5): arm + result feed -------------------------

    /** Publish the `overridden` telemetry on TRANSITIONS only (the tracker
     *  re-affirms the flag every frame; the UI badge needs edges, not spam). */
    function publishOverridden(v: boolean): void {
      if (v === overriddenTele) return;
      overriddenTele = v;
      s.telemetry({ overridden: v });
    }

    /** (Re-)arm the chained tracker at `center` with the contract's KCF
     *  template size. Native clamps the ROI to the frame. */
    function armTracker(center: Point2d): void {
      if (!tk) return;
      tk.arm(
        RECT.fromCenter(center, {
          width: s.state.kernel.w,
          height: s.state.kernel.h,
        }),
      );
      trackerArmed = true;
    }

    // Per-result routing off the tracker thread (pure reducer — see
    // tracker-feed.ts for the gating/tolerance semantics). Every path forwards
    // the scalar target + the override flag to the KERNEL, which carries it
    // onto `projection.overridden` for the PID step.
    const trackerFeed = createDisparityTrackerFeed(
      {
        armed: () => trackerArmed,
        onDrag(center) {
          // Drag in flight: the tracker echoes the override point every frame.
          // The pointer handler already pushed it synchronously; this keeps
          // target+flag coherent at frame rate even if a pointer move was
          // coalesced away.
          lastGood = center;
          s.setState("target", center);
          sendParams({ target: center, overridden: true });
          publishOverridden(true);
        },
        onTrack(center, bbox) {
          trackerActive = true;
          lastGood = center;
          s.setState("target", center);
          sendParams({ target: center, overridden: false });
          s.telemetry({ tracker_bbox: bbox });
          publishOverridden(false);
        },
        onLost() {
          // Tolerance exceeded: release auto-follow (JS gate), hold the last
          // good target — the same policy the old in-kernel tracker had.
          trackerArmed = false;
          trackerActive = false;
          s.setState("target", lastGood);
          s.telemetry({ tracker_bbox: null });
        },
      },
      TRACKER_LOST_TOLERANCE,
    );

    // --- PID-node override slot (generic volts path ONLY since §3.5) --------

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

    /**
     * Reseed the controllers from the LAST override value so control resumes
     * CONTINUOUSLY (velocity-form integrator ⇒ output = last command = no jump).
     * Invoked by `override.release()`; the reconstruction inverse lives in the
     * pure {@link seedVergence} (see its SPACE CONTRACT).
     *
     * GENERIC volts path only since §3.5: pointer drags ride the TRACKER
     * override (the PID keeps running — nothing pins, nothing seeds), so the
     * slot is only ever engaged by the `pidOverride` command with arbitrary
     * per-eye volts that genuinely encode a vergence. Those are recovered
     * through V2A (per-eye lossy round-trip accepted — there is no shared ray
     * to seed from on this path).
     */
    function seedFromOverride(v: VergenceVolts): void {
      if (!triple || !triple.undistort) return;
      const conv = triple.conv;
      const gL = conv.V2A.L(v.l);
      const gR = conv.V2A.R(v.r);
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
      // No tracker values from the kernel anymore (§3.5) — the chained
      // tracker's results arrive on their own path (`trackerFeed`).
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
     *  by `node.step` only when the (generic) override is NOT engaged (the node
     *  resets the controllers itself while overridden). Returns the held/last
     *  volts on any hold condition so the actuation output freezes rather than
     *  winds down.
     *
     *  §3.5 "act correspondingly" on `projection.overridden` (a tracker-override
     *  drag riding the projection): the PID KEEPS STEPPING — the foveas servo
     *  onto the moving dragged tile — with two adjustments:
     *   - the freeze window is held open (a drag is user activity; a long drag
     *     must not hit the convergence timeout mid-gesture);
     *   - status reads "manual" so the UI shows the drag.
     *  No rate clamp/softening beyond the existing PID saturation: every DOF's
     *  integrator is anti-windup-clamped to its physical range (`verge`
     *  [0, max], `pan` ±SHIFT_LIMIT, `v_shift` ±VSHIFT_LIMIT), so a long drag
     *  toward an unreachable/unmatchable target at worst rests a controller at
     *  its limit — the bounded-windup case the limits exist for. A low match
     *  score during a drag holds (as always): the foveas pause until the
     *  matcher reacquires the dragged tile. */
    function controlStep(projection: ScopeProjection): VergenceVolts {
      if (!triple || !triple.undistort) {
        status = "no calibration";
        return commandedVolts;
      }
      if (projection.overridden) windowStart = now(); // drag = activity
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
      status = projection.overridden ? "manual" : "tracking";
      return { l: result.left, r: result.right };
    }

    function runControl(projection: ScopeProjection): void {
      if (!pidNode) return;
      commandedVolts = outputOf(pidNode.step(() => controlStep(projection)));
      if (pidNode.override.engaged) status = "manual";
      pushVolts();
    }

    // --- actuation (push-model: at the projection/PID result rate) --------

    /** Push the current command to the controller node's position input; the
     *  MCU stream holds it between pushes (a hold path returning the last
     *  volts re-pushes the same value — the `StreamUpdateGate` dedupes it).
     *  `update()`'s synchronous predicted-volt return feeds the volt telemetry
     *  the old loop's `onVolts` carried. */
    function pushVolts(): void {
      if (!posInput) return;
      const p = posInput.update({ left: commandedVolts.l, right: commandedVolts.r });
      onVolts({ L: p.left, R: p.right }, lastActuateMs);
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
      const serialC = t.leases.C.camera.serial;
      const cSourceId = undistortIds.C ?? nodeId.convert(serialC);
      const pipeInputs: PipeInput[] = [
        connectCameraPipe("L", undistortIds.L ?? nodeId.convert(t.leases.L.camera.serial)),
        connectCameraPipe("C", cSourceId),
        connectCameraPipe("R", undistortIds.R ?? nodeId.convert(t.leases.R.camera.serial)),
      ];

      // §3.5: the chained KCF tracker — its OWN native thread, tapping the
      // SAME C brick the kernel reads (undistort; convert fallback), so it
      // tracks exactly what the matcher sees. Resolved by PIPE id (the brick
      // was just advertised); the tap keeps the brick awake independent of
      // SHM consumers (same demand rule as the §5 chain). Its disposer is
      // added HERE — after the pipe disconnects, BEFORE the producer retirers
      // (DisposerBag is FIFO) — so the tap detaches before the brick dies.
      const kcfId = nodeId.undistortKcf(serialC);
      try {
        tk = createChainedTracker(cSourceId, kcfId);
      } catch (e) {
        // No brick on the pipe (shouldn't happen post-advertise) — degrade to
        // pointer-only targeting, same UX as tracker-disabled.
        console.error("[disparity-scope] chained tracker unavailable:", e);
        tk = null;
      }
      if (tk) {
        disposers.add(() => {
          tk?.release(); // closes the async iterator → consumeTracker exits
          tk = null;
          trackerArmed = false;
          trackerActive = false;
        });
        void consumeTracker(tk, trackerFeed);
      }

      // Now defer the producer teardown (runs AFTER the consumer disconnects
      // and the tracker tap is released).
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
            // The chained tracker does NOT self-report topology (no row from
            // native Topology.report() — unlike undistort bricks), so the
            // session registers it: C source → kcf (frames, native tap) and
            // kcf → kernel (the scalar target feed; `overridden` is DATA on
            // that stream, not topology).
            ...(tk
              ? [
                  {
                    id: kcfId,
                    kind: "kcf",
                    owner: "win/disparity-scope",
                    output: { kind: "track" } as const,
                    transport: "native" as const,
                  },
                ]
              : []),
          ],
          edges: [
            ...pipeInputs.map((p, i) => ({
              from: pipeIds[i]!,
              to: kernelId,
              port: p.role,
              type: bgra,
            })),
            ...(tk
              ? [
                  { from: cSourceId, to: kcfId, port: "C", type: bgra },
                  {
                    from: kcfId,
                    to: kernelId,
                    port: "target",
                    type: { kind: "track" } as const,
                  },
                ]
              : []),
          ],
        }),
      );
      // The tracker self-meters under the kcf node id — probe it out-of-loop
      // so utilization/rate/drops fold onto the node's badge.
      if (tk) {
        disposers.add(
          registerNativeProbe(
            (): Record<string, WorkloadSnapshot> =>
              tk ? { [kcfId]: trackerWorkload(kcfId, tk.probe()) } : {},
          ),
        );
      }

      // The PID controller node: scope → pid (input edge) + pid → controller
      // (output edge, filed on the controller node by the wiring shim).
      // `createPidNode` owns its own graph registration; dispose retires it.
      pidNode = createPidNode<VergenceVolts>({
        id: pidId,
        kind: "pid",
        owner: "win/disparity-scope",
        inputs: [{ from: kernelId, port: "projection" }],
        outputs: [{ to: nodeId.controller(), port: "volt" }],
        controllers: { pan, verge, v_shift },
        seed: seedFromOverride,
      });
      disposers.add(() => {
        pidNode?.dispose();
        pidNode = null;
      });

      // Open the controller-node position input (was `startActuationLoop`).
      // The PID node's `pid → controller` output edge above already covers the
      // topology, so `from` is omitted (no duplicate edge). The immediate push
      // reproduces the old loop's first tick: enable + drive to the current
      // command (origin) so the mirrors are parked before the first projection.
      posInput = controllerNode().openPosition("disparity-scope", {
        initial: { left: commandedVolts.l, right: commandedVolts.r },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      pushVolts();
      // Auto-follow was left on: arm the fresh tracker at the current target.
      if (s.state.tracker_enabled) armTracker(s.state.target);
      // Surface the measured magnification (null = nominal-zoom fallback) so
      // the UI can display the actual match scale instead of guessing from
      // the (now crop-only) zoom knob.
      s.telemetry({ ready: true, match_magnification: measuredMatchZoom() });
    }

    function idleSession(): void {
      // Stop actuating FIRST (as the old loop stop did): terminate the MCU
      // stream + disable iff the node enabled for us (fire-and-forget close).
      void posInput?.close();
      posInput = null;
      worker?.terminate(); // terminate before disconnect: no reads after the gate drops
      worker = null;
      trackerActive = false;
      dragging = false;
      overriddenTele = false;
      disposers.dispose(); // disconnect pipes, release tracker, retire undistort, dispose pid node
      publishOverride(); // pidNode is now null → released state
      releaseLeases(triple);
      triple = null;
      status = "initializing";
      commandedVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
      s.resetTelemetry([
        "ready",
        "status",
        "tracker_bbox",
        "match_magnification",
        "overridden",
      ]);
    }

    return {
      commands: {
        async pointer({ p, buttons: _buttons, phase }) {
          // §3.5 drag semantics: down/move engage the TRACKER's override; the
          // PID vergence node KEEPS RUNNING throughout (nothing pins its
          // output), steering the foveas to converge on the moving dragged
          // tile. The `overridden` flag rides tracker → kernel target →
          // projection → PID.
          if (phase !== "up") {
            if (phase === "down") {
              dragging = true;
              trackerActive = false;
              s.telemetry({ tracker_bbox: null });
            }
            tk?.override(p);
            // Push synchronously too (don't wait one tracker frame) — the feed
            // re-affirms the same values at result rate.
            lastGood = p;
            s.setState("target", p);
            sendParams({ target: p, overridden: true });
            publishOverridden(true);
            status = "manual";
            // Refresh the freeze window NOW (the flagged projection that also
            // refreshes it lags one kernel tick — a drag started while frozen
            // must servo immediately).
            windowStart = now();
          } else {
            dragging = false;
            windowStart = now(); // drag end restarts the convergence window
            sendParams({ target: s.state.target, overridden: false });
            publishOverridden(false);
            if (tk) {
              // Native releaseOverride RE-ARMS KCF at the drag end on the next
              // frame; the PID continues seamlessly (no seed — it was never
              // interrupted). With auto-follow OFF the JS gate ignores the
              // re-armed tracker's results (native has no disarm — same
              // discipline as tracking-single).
              tk.releaseOverride();
              trackerArmed = s.state.tracker_enabled;
              trackerActive = false;
            }
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
          const state = applyPidOverride(pidNode.override, command);
          if (state.engaged && state.value) {
            commandedVolts = state.value;
            status = "manual";
            // Apply immediately (the old 1 ms loop picked this up within a
            // tick) — don't wait for the next projection to push it.
            pushVolts();
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
        kernel() {
          // The template size feeds the session-side arm ROI now (the kernel
          // runs no KCF — no params to push). Re-arm live at the current
          // target so the knob takes effect immediately — unless a drag is in
          // flight (its release re-arms anyway).
          if (trackerArmed && !dragging) armTracker(s.state.target);
        },
        tracker_enabled(on) {
          if (!on) {
            trackerArmed = false; // JS gate: results ignored (no native disarm)
            trackerActive = false;
            s.telemetry({ tracker_bbox: null });
          } else if (!dragging) {
            armTracker(s.state.target);
          }
          // While dragging, the pointer-up releaseOverride re-arms and
          // `trackerArmed` follows the (fresh) tracker_enabled state there.
        },
      },
      activate() {
        void activateSession();
      },
      idle: idleSession,
    };
  });
}
