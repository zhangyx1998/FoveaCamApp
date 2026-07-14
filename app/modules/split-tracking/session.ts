// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// split-tracking session — TWO INDEPENDENT single-eye visual servos over the
// leased L/C/R triple. Each fovea runs its own object tracker (hybrid / kcf) on
// its own native thread, tapping that eye's undistort-or-convert pipe; each
// mirror steers INDEPENDENTLY to keep its tracked target at the fovea frame
// CENTER. No stereo/vergence coupling — the two sides never touch each other's
// state. Behavior spec: docs/spec/split-tracking.md.
//
// Scaffold ported from calibrate-extrinsic (leasing/publishSerials/undistort
// advertise/capture+recording) + manual-control (openPosition push model,
// controller-absent retry) + disparity-scope (chained tracker + reducer +
// finite-difference Jacobian, per-eye here). NO Vue (orchestrator zero-Vue
// boundary). RIG-GATED: tracker + servo behavior is unverified on hardware.

import { type ServerSession } from "@orchestrator/runtime";
import {
  defineResourceSession,
  type ResourceScope,
} from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { controllerNode, type PositionInput } from "@orchestrator/controller-node";
import { activeController } from "@orchestrator/controller";
import { report } from "@orchestrator/diagnostics";
import {
  DisposerBag,
  publishSerials,
  releaseLeases,
} from "@orchestrator/session-resources";
import { ORIGIN_POS, VOLT_TELEMETRY_INTERVAL_MS } from "@orchestrator/fovea-pipeline";
import {
  advertiseHomographyUndistortPipe,
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import { conversionComputeH, startHomographyFeeder } from "@orchestrator/homography-feeder";
import { pushHomography } from "core/Aravis";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { registerGraphWiring } from "@orchestrator/graph-topology";
import { registerNativeProbe } from "@orchestrator/native-probes";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";
import { createRawRecording } from "@orchestrator/raw-recording";
import {
  createCaptureHelper,
  rawTripleShot,
  type CaptureHelper,
} from "@orchestrator/capture-helper";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import { deriveFoveaIntrinsics } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";
import { RECT } from "@lib/util/geometry";
import type { Point2d, Rect, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
// Direct core import in a session — accepted precedent (disparity-scope): the
// PURE logic lives in tracking.ts/jacobian.ts so vitest never loads the addon.
import {
  createChainedHybridTracker,
  createChainedTracker,
  type KcfTracker,
  type TrackerMeter,
} from "core/Tracker";
import { splitTracking, type Eye } from "./contract";
import {
  DEFAULT_GAINS,
  EyeServo,
  reduceResult,
  tileRect,
  TRACKER_LOST_TOLERANCE,
  type Mat2,
  type PidGains,
  type SideHandlers,
  type TileSize,
} from "./tracking";
import { eyeJInv } from "./jacobian";

const EYES = ["L", "R"] as const;
type TrackerType = "hybrid" | "kcf";

// --- RIG-TUNABLE servo constants (stage-f servo pass pins these) -------------
/** Effective fovea-view magnification fed to `deriveFoveaIntrinsics` for the
 *  focal used in the px→volt model. The fovea views are homography-warped to
 *  the WIDE undistorted frame (≈ wide focal ⇒ zoom 1). If a rig taps the RAW
 *  (natively magnified) fovea pipe instead, set this to the measured
 *  magnification. RIG-TUNABLE. */
const FOVEA_TRACK_ZOOM = 1;
/** Per-tick volt saturation for each eye's servo step (anti-slam). RIG-TUNABLE. */
const SERVO_MAX_STEP_V = 5.0;
/** Fallback voltage envelope when no controller is bound (controller.dv). */
const DEFAULT_DV = 170.0;

/** Adapt a native tracker meter to the `WorkloadSnapshot` shape (keyed by node
 *  id so it folds onto the graph node's badge). Ported from disparity-scope. */
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

const now = () => performance.now();
const clampAxis = (v: number, lim: number): number => Math.max(-lim, Math.min(lim, v));

export default function splitTrackingSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  rawPipes: RawPipeRegistry,
  compress?: CompressPipeSeam,
): ServerSession<typeof splitTracking> {
  return defineResourceSession("split-tracking", splitTracking, (s) => {
    let triple: CalibratedTriple | null = null;
    let posInput: PositionInput | null = null;
    let lastActuateMs = 0;

    // Capture + recording over the leased triple (calibrate-extrinsic port).
    let captureHelper: CaptureHelper | null = null;
    let captureCenter: { shmName: string; maxBytes: number; channels: number } | null = null;

    const recording = createRawRecording({
      id: "recorder/split-tracking",
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

    // --- per-eye tracker + servo state (fully independent per side) ----------
    const tk: Record<Eye, KcfTracker | null> = { L: null, R: null };
    /** Tracker source pipe + graph node id per eye — CONSTANT across a swap. */
    const trackerSrc: Record<Eye, { pipe: string | null; node: string | null }> = {
      L: { pipe: null, node: null },
      R: { pipe: null, node: null },
    };
    let runningTrackerType: TrackerType = "hybrid";
    /** JS-side auto-follow gate per eye — while false the tracker keeps running
     *  but its results are IGNORED (paused / lost-released). */
    const armed: Record<Eye, boolean> = { L: false, R: false };
    /** Consecutive-miss counters (reduceResult owns them; we just hold them). */
    const misses: Record<Eye, number> = { L: 0, R: 0 };
    /** Last (re-)armed / tracked center per eye — re-arm target on setTile. */
    const lastCenter: Record<Eye, Point2d> = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };
    /** Per-eye frame size (fovea image px) — the servo's goal is the center. */
    const size: Record<Eye, Size> = {
      L: { width: 0, height: 0 },
      R: { width: 0, height: 0 },
    };
    /** Per-eye visual servo (px error → volt delta; PID with anti-windup). */
    const servo: Record<Eye, EyeServo> = {
      L: new EyeServo(s.state.gains, SERVO_MAX_STEP_V),
      R: new EyeServo(s.state.gains, SERVO_MAX_STEP_V),
    };
    /** Accumulated commanded volt per eye (the servo output). */
    const volt: Record<Eye, Pos> = { L: { ...ORIGIN_POS }, R: { ...ORIGIN_POS } };
    /** Last servo-step wall time per eye (dt source). */
    const lastStepAt: Record<Eye, number> = { L: 0, R: 0 };

    const actuateMsStats = new RollingStats(0.9, 2, "ms");
    let lastVoltEmit = 0;
    let blocked: string | null = null;

    function publishBlocked(reason: string | null): void {
      if (reason === blocked) return;
      blocked = reason;
      s.telemetry({ blocked: reason });
      if (reason !== null) report("split-tracking", reason, "warning");
    }

    function frameCenter(eye: Eye): Point2d {
      return { x: size[eye].width / 2, y: size[eye].height / 2 };
    }

    /** The eye's px→volt inverse Jacobian at its CURRENT commanded volt — the
     *  finite-difference geometric model (jacobian.ts). Null (⇒ servo holds)
     *  without a calibrated wide intrinsic. RIG-GATED sign/scale. */
    function jInvFor(eye: Eye): Mat2 | null {
      if (!triple || !triple.undistort) return null;
      const angle0 = triple.conv.V2A[eye](volt[eye]);
      const { f } = deriveFoveaIntrinsics(triple.undistort, angle0, FOVEA_TRACK_ZOOM);
      return eyeJInv({ focal: f, angle0, a2v: (a) => triple!.conv.A2V[eye](a) });
    }

    // --- actuation --------------------------------------------------------

    /** Push the current per-eye volt pair to the controller node; adopt the
     *  predicted volts back (they hold when no controller is bound). */
    function pushPair(): void {
      if (!posInput) return;
      const applied = posInput.update({ left: volt.L, right: volt.R });
      volt.L = applied.left;
      volt.R = applied.right;
    }

    function voltEnvelope(): number {
      return activeController()?.dv ?? DEFAULT_DV;
    }

    // --- per-eye tracker result routing (reduceResult + SideHandlers) --------
    // Local mirrors of the two per-eye records (the runtime doesn't hand back
    // the last telemetry/state object), published whole on each change.
    type TrackedView = { center: Point2d | null; bbox: Rect | null; found: boolean } | null;
    let trackedTele: Record<Eye, TrackedView> = { L: null, R: null };
    let trackingState: Record<Eye, boolean> = { L: false, R: false };

    function setTracked(eye: Eye, view: TrackedView): void {
      trackedTele = { ...trackedTele, [eye]: view };
      s.telemetry({ tracked: trackedTele });
    }
    function setTracking(eye: Eye, on: boolean): void {
      if (trackingState[eye] === on) return;
      trackingState = { ...trackingState, [eye]: on };
      s.telemetry({ tracking: trackingState });
    }

    function handlersFor(eye: Eye): SideHandlers {
      return {
        onTrack(center: Point2d, bbox: Rect) {
          lastCenter[eye] = center;
          setTracked(eye, { center, bbox, found: true });
          const jInv = jInvFor(eye);
          if (!jInv) {
            publishBlocked("no calibration (wide intrinsic unavailable)");
            setTracking(eye, false);
            return;
          }
          const err: Point2d = {
            x: center.x - frameCenter(eye).x,
            y: center.y - frameCenter(eye).y,
          };
          const t = now();
          const dt = lastStepAt[eye] > 0 ? (t - lastStepAt[eye]) / 1000 : 0;
          lastStepAt[eye] = t;
          const dvolt = servo[eye].step(err, jInv, dt);
          const lim = voltEnvelope();
          volt[eye] = {
            x: clampAxis(volt[eye].x + dvolt.x, lim),
            y: clampAxis(volt[eye].y + dvolt.y, lim),
          };
          pushPair();
          if (blocked === null || blocked.startsWith("no calibration"))
            publishBlocked(null);
          setTracking(eye, true);
        },
        // No tracker `override()` path in split-tracking (drags are session
        // commands, not tracker overrides), so onDrag is never routed — but the
        // reducer contract requires it. Keep the overlay marker live if it fires.
        onDrag(center: Point2d) {
          lastCenter[eye] = center;
        },
        onLost() {
          // Stop servoing this eye + hold its mirror at the last volt.
          armed[eye] = false;
          setTracking(eye, false);
          publishBlocked(`${eye} target lost`);
          setTracked(eye, { center: lastCenter[eye], bbox: null, found: false });
        },
      };
    }

    /** Drive one tracker's async iteration into the reducer until it closes. */
    async function drainTracker(eye: Eye, tracker: KcfTracker): Promise<void> {
      const handlers = handlersFor(eye);
      try {
        for await (const r of tracker)
          misses[eye] = reduceResult(r, armed[eye], misses[eye], handlers);
      } catch {
        // iterator closed on release / teardown — normal exit
      }
    }

    function createTrackerOfType(eye: Eye, type: TrackerType): KcfTracker {
      const src = trackerSrc[eye];
      if (!src.pipe || !src.node) throw new Error("tracker source not ready");
      return type === "kcf"
        ? createChainedTracker(src.pipe, src.node)
        : createChainedHybridTracker(src.pipe, src.node);
    }

    /** (Re-)arm one eye's tracker on the FIXED frame-center tile with the
     *  current tile size, reset its servo, and engage its auto-follow gate.
     *  The seed center is ALWAYS frameCenter (the tile is drawn centered). */
    function armEye(eye: Eye): void {
      if (!tk[eye] || !size[eye].width) return;
      servo[eye].reset();
      misses[eye] = 0;
      lastStepAt[eye] = 0; // fresh dt on the next result
      lastCenter[eye] = frameCenter(eye); // keep onLost telemetry sane pre-first-result
      tk[eye]!.arm(tileRect(frameCenter(eye), s.state.tile, size[eye]));
      armed[eye] = true;
      setTracking(eye, true);
      if (blocked && (blocked === `${eye} target lost` || blocked.startsWith("no calibration")))
        publishBlocked(null);
    }

    /** Self-contained hot-swap of BOTH eyes' engine (release → create → consume
     *  → re-arm iff armed), degrading to the running type on a factory throw.
     *  Reimplemented here (no cross-module import; disparity-scope's pattern). */
    function performTrackerSwap(type: TrackerType): void {
      if (!trackerSrc.L.pipe && !trackerSrc.R.pipe) return; // idle
      let running: TrackerType = type;
      for (const eye of EYES) {
        const src = trackerSrc[eye];
        if (!src.pipe || !src.node) continue;
        const wasArmed = armed[eye];
        tk[eye]?.release(); // closes the iterator → drainTracker exits
        tk[eye] = null;
        armed[eye] = false;
        let created: KcfTracker | null = null;
        try {
          created = createTrackerOfType(eye, type);
        } catch {
          // Degrade to the previously-running type so a tracker keeps running.
          if (runningTrackerType !== type) {
            try {
              created = createTrackerOfType(eye, runningTrackerType);
              running = runningTrackerType;
            } catch {
              created = null;
            }
          } else created = null;
        }
        tk[eye] = created;
        if (created) {
          void drainTracker(eye, created);
          if (wasArmed) armEye(eye);
        }
      }
      runningTrackerType = running;
      // Never advertise a type that isn't running — pin the select to reality.
      if (running !== s.state.tracker_type) s.setState("tracker_type", running);
    }

    // --- lifecycle --------------------------------------------------------

    async function activateSession(scope: ResourceScope): Promise<void> {
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing cameras" },
        { id: "pipes", label: "Advertising undistort pipes" },
        { id: "trackers", label: "Starting trackers" },
        { id: "controller", label: "Wiring controller" },
      ]);

      monitor.start("lease");
      const t = await scope.use(() => acquireTriple(s), releaseLeases); // drains LAST
      if (!t) return; // frozen at "Leasing cameras" (contention/fail)
      triple = t;
      monitor.done("lease");

      const taps = new DisposerBag();
      publishSerials(t.leases, taps, s);
      scope.defer(() => taps.dispose());

      // DISPLAY-ONLY: label the leased triple by role in the profiler.
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

      monitor.start("pipes");
      // Center intrinsic undistort (capture center + wide-frame parity). L/R
      // homography undistort pipes fed H(mirrorAt) — the fovea views the tracker
      // taps + the renderer binds. Convert fallback on an uncalibrated fovea cam.
      let undistortC: string | null = null;
      if (t.undistort) {
        undistortC = advertiseUndistortPipe(undistortSeam, t.leases.C.camera, t.undistort.calibration);
        scope.defer(() => retireUndistortPipe(undistortSeam, undistortC!));
      }
      const computeH = conversionComputeH(t.conv);
      const undistortEye: Record<Eye, string | null> = { L: null, R: null };
      for (const eye of EYES) {
        if (t.undistort) {
          const pipeId = advertiseHomographyUndistortPipe(undistortSeam, t.leases[eye].camera);
          undistortEye[eye] = pipeId;
          const stopFeeder = startHomographyFeeder({
            pipeId,
            side: eye,
            computeH,
            push: pushHomography,
          });
          scope.defer(() => {
            stopFeeder(); // stop pushing BEFORE the brick detaches
            retireUndistortPipe(undistortSeam, pipeId);
          });
        }
        // Fovea view/tracker source: the homography-undistort pipe, else convert.
        const src = undistortEye[eye] ?? nodeId.convert(t.leases[eye].camera.serial);
        trackerSrc[eye].pipe = src;
        trackerSrc[eye].node = nodeId.undistortKcf(t.leases[eye].camera.serial);
        // Per-eye frame size (undistort preserves the camera's dims).
        size[eye] = {
          width: t.leases[eye].camera.getFeatureInt("Width"),
          height: t.leases[eye].camera.getFeatureInt("Height"),
        };
      }
      s.setState("undistort", { L: undistortEye.L, R: undistortEye.R });
      scope.defer(() => s.setState("undistort", { L: null, R: null }));
      s.telemetry({ size: { L: { ...size.L }, R: { ...size.R } } });
      monitor.done("pipes");

      monitor.start("trackers");
      runningTrackerType = s.state.tracker_type as TrackerType;
      for (const eye of EYES) {
        try {
          tk[eye] = createTrackerOfType(eye, runningTrackerType);
        } catch (e) {
          console.error(`[split-tracking] chained tracker (${eye}) unavailable:`, e);
          tk[eye] = null;
        }
        if (tk[eye]) {
          const eyeTk = tk[eye]!;
          const node = trackerSrc[eye].node!;
          void drainTracker(eye, eyeTk);
          scope.defer(() => {
            eyeTk.release(); // closes the iterator → drainTracker exits
            tk[eye] = null;
            armed[eye] = false;
          });
          // Register the tracker's graph node + probe (self-metered by node id).
          scope.defer(
            registerGraphWiring({
              roles: {},
              nodes: [
                {
                  id: node,
                  kind: "kcf",
                  owner: "win/split-tracking",
                  output: { kind: "track" } as const,
                  transport: "native" as const,
                },
              ],
              edges: [
                { from: trackerSrc[eye].pipe!, to: node, port: eye, type: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" } as const },
              ],
            }),
          );
          scope.defer(
            registerNativeProbe((): Record<string, WorkloadSnapshot> =>
              tk[eye] ? { [node]: trackerWorkload(node, tk[eye]!.probe()) } : {},
            ),
          );
        }
      }
      monitor.done("trackers");

      monitor.start("controller");
      // Push model (manual-control): the SESSION owns the volt pair; onTrack
      // pushes on each accepted result, the ticker holds + publishes telemetry.
      posInput = controllerNode().openPosition("split-tracking", {
        initial: { left: { ...volt.L }, right: { ...volt.R } },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      scope.defer(() => {
        void posInput?.close(); // terminate the MCU stream + disable-iff-we-enabled
        posInput = null;
      });

      // Telemetry + controller-absent retry ticker (manual-control idiom,
      // lightweight): re-push the held pair (mirror hold), publish volt/perf,
      // and flip `blocked` when the controller is missing.
      {
        const ticker = setInterval(() => {
          const c = activeController();
          if (!c || !c.connected) {
            publishBlocked("no controller connected");
          } else if (blocked === "no controller connected") {
            publishBlocked(null);
          }
          pushPair(); // hold the mirrors at the current command
          actuateMsStats.push(lastActuateMs);
          const tnow = now();
          if (tnow - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
            lastVoltEmit = tnow;
            s.telemetry({
              volt: { L: { ...volt.L }, R: { ...volt.R } },
              perf: { actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max } },
            });
            actuateMsStats.resetMax();
          }
        }, VOLT_TELEMETRY_INTERVAL_MS);
        scope.defer(() => clearInterval(ticker));
      }

      // --- capture + recording (calibrate-extrinsic port, raw stacks) --------
      // Persistent center pipe (refcount++ keeps the producer live for the
      // worker's one-shot read); center = the convert pipe (proposal §capture).
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
        id: nodeId.win("split-tracking", "capture"),
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
                note: "split-tracking: raw stacks, no per-shot mirror pose (no wrap)",
              })
            : null,
        recordingActive: () => recording.active,
        telemetry: (patch) => s.telemetry(patch),
      });
      captureHelper.build();
      // Awaited drain: an in-flight capture must finish (raw pipes release) then
      // the recording finalizes — BEFORE the leases release (LIFO; registered
      // AFTER scope.use, so it drains before releaseLeases).
      scope.defer(async () => {
        await captureHelper?.activeCapture;
        await captureHelper?.stop();
        captureHelper = null;
      });
      scope.defer(async () => void (await recording.stop()));

      s.telemetry({ ready: true });
      monitor.done("controller");
      monitor.complete(); // spin-up finished — clear the overlay
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        // After the full drain (leases already released). Reset session-local
        // state so a re-entry starts clean.
        for (const eye of EYES) {
          armed[eye] = false;
          misses[eye] = 0;
          size[eye] = { width: 0, height: 0 };
          trackerSrc[eye].pipe = trackerSrc[eye].node = null;
          volt[eye] = { ...ORIGIN_POS };
          lastStepAt[eye] = 0;
          servo[eye].reset();
        }
        trackedTele = { L: null, R: null };
        trackingState = { L: false, R: false };
        blocked = null;
        s.resetTelemetry(["ready", "tracked", "tracking", "volt", "blocked"]);
      },
      commands: {
        async steerEye({ eye, volt: v }) {
          // Manual mirror steer (PosView voltage pad, manual-control's direct
          // volt write): stop this eye's servo/tracker and drive the mirror
          // directly to the commanded volt, clamped to the live envelope. No
          // arm/seed here.
          armed[eye] = false;
          setTracking(eye, false);
          const lim = voltEnvelope();
          volt[eye] = { x: clampAxis(v.x, lim), y: clampAxis(v.y, lim) };
          pushPair();
          // A manual steer is a valid live command — clear a stale lost / no-cal
          // block for this eye (mirror onTrack's blocked-clear).
          if (blocked && (blocked === `${eye} target lost` || blocked.startsWith("no calibration")))
            publishBlocked(null);
        },
        async armCenter({ eye }) {
          armEye(eye);
        },
        async setTrackerType({ type }) {
          performTrackerSwap(type);
        },
        async setTile(tile: TileSize) {
          s.setState("tile", tile);
          // Re-arm both armed sides live on the fixed center tile (kernel() idiom).
          for (const eye of EYES) if (armed[eye]) armEye(eye);
        },
        async setGains(gains: PidGains) {
          s.setState("gains", gains);
          for (const eye of EYES) servo[eye].setGains(gains);
        },
        // Capture — forward to the shared helper (guards live inside it).
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
          // Exclusivity (spec §capture): no recording while a capture shot holds
          // the shared raw pipes.
          if (captureHelper?.capturing) return false;
          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
        },
      },
      watch: {
        // Tile / gains are also settable via commands; the watches keep a direct
        // state seed (e.g. URL) applied on activate.
        tile() {
          for (const eye of EYES) if (armed[eye]) armEye(eye);
        },
        gains(g) {
          for (const eye of EYES) servo[eye].setGains(g as PidGains);
        },
        tracker_type(type) {
          if (!trackerSrc.L.pipe && !trackerSrc.R.pipe) return; // idle
          if ((type as TrackerType) === runningTrackerType) return;
          performTrackerSwap(type as TrackerType);
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
