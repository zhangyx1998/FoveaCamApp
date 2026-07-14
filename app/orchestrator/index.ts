// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator process entry. Runs in an Electron `utilityProcess` (event loop not
// bound to any UI render loop), so `core` runs here with full async throughput; main
// hands us one `MessagePortMain` per renderer connection. This file is the session
// registration list plus the two cross-cutting sessions (`system`, `controller`).

import { Shm, Pipe, Aravis, Topology, steadyNowNs, cleanup, installCrashHandler } from "core";
import { onClockMetrics } from "core/Aravis";
import { setHostClock } from "./time-align.js";
import { wireClockMetrics } from "./clock-calibration.js";
import {
  createShmFrameTransport,
  type ShmApi,
} from "./frame-transport.js";
import { Hub, setFrameTransportFactory, type ServerSession } from "./runtime.js";
import {
  armHardwareGate,
  signalHardwareClear,
  onHardwareWaitChange,
} from "./hardware-gate.js";
import { releaseAll, setRegistryPipeSeam } from "./registry.js";
import { pipeSession, asBroker, createFoveaMaterializer } from "./pipe-session.js";
import { createRawPipeRegistry } from "./raw-pipe.js";
import { buildTopology } from "./graph-topology.js";
import { registerNativeProbe, registerNodeReports, nodeReports } from "./native-probes.js";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats.js";
import { onReport, onSpan, span } from "./diagnostics.js";
import { systemSession } from "./sessions/system.js";
import { controllerSession } from "./sessions/controller.js";
import { activeController, setActiveController } from "./controller.js";
import { controllerNode } from "./controller-node.js";
import liveViewSession from "@modules/single-capture/session";
import manageCamerasSession from "@modules/manage-cameras/session";
import manualControlSession from "@modules/manual-control/session";
import multiFoveaSession from "@modules/multi-fovea/session";
import disparityScopeSession from "@modules/disparity-scope/session";
import splitTrackingSession from "@modules/split-tracking/session";
import calibrateIntrinsicSession from "@modules/calibrate-intrinsic/session";
import calibrateDriftSession from "@modules/calibrate-drift/session";
import calibrateDistortionSession from "@modules/calibrate-distortion/session";
import calibrateExtrinsicSession from "@modules/calibrate-extrinsic/session";

// S5 (docs/history/refactor/orchestrator.md §7.1): boot phase timing. `FOVEA_FORK_TS`
// is stamped by `main.ts` right before `utilityProcess.fork()`; by the time
// this line runs, every statically-imported module (including `core`'s
// native addon, imported transitively above) has already been resolved —
// ESM evaluates the whole static import graph bottom-up before this file's
// body runs — so this one span covers fork + native-addon load + module
// eval as a single leg (there's no way to isolate "core import" alone
// without switching the whole graph to dynamic imports, not worth the risk
// for a measurement feature).
// Teardown-hardening (Task 3): trace any native crash to stderr with a
// symbolicatable backtrace before the process dies, WITHOUT changing exit-code
// semantics (exit 6 still triggers the janitor). Earliest core-loading point —
// `core` is already resolved by the static import above.
installCrashHandler();

const forkTs = Number(process.env.FOVEA_FORK_TS);
if (Number.isFinite(forkTs)) span("boot.forkToLoad", Date.now() - forkTs);

// Disposable-orchestrator gate (ruling 2): close the hardware-acquisition gate
// at boot so no session opens a camera / the MEMS serial until main sends
// `hardware-clear` (the previous hardware instance confirmed dead + swept).
// Armed BEFORE any port attaches (subscriptions — hence activation — can only
// arrive after the first `channel:connect` message below).
armHardwareGate();

const hub = new Hub();
setFrameTransportFactory(() => createShmFrameTransport(Shm as ShmApi));

// Unified time (FINAL ruling 0): the NATIVE steady clock is the single time
// authority — every JS hostNowNs reading (mirror history, calibration
// registry ages, homography feeder stamps) joins the owner-applied frame
// domain. Then arm the clock-metrics push channel: the camera owner threads
// calibrate autonomously (init + 30s drift) and their rows land in the JS
// registry through this one gated callback.
setHostClock(steadyNowNs);
wireClockMetrics(onClockMetrics);

// Forward process-wide diagnostics (registry sink-throw isolation, etc.) to
// every connected renderer, so failures are visible without watching the
// orchestrator console. See docs/history/refactor/orchestrator.md §12.1 C7.
onReport((scope, message, level) => hub.reportError(scope, message, level));
// Same pattern for structured timing spans (§7.1 S5) — live broadcast so a
// future profiler window can render a timeline without polling.
onSpan((s) => hub.reportSpan(s));

// --- WS1 pipe broker: advertises `camera:<serial>` SHM pipes (real-1c) -----
// C's pipe session + broker; the registry (un)advertises a pipe per shared
// camera and attaches B's native `CaptureSink` (the SHM preview write is now
// native, off the JS loop). Both native seams are cast here (Aravis pipe NAPIs
// aren't in the d.ts yet — B-owned) so registry.ts stays type-clean + testable.
// C-24 step 4: the fovea crop brick (B-24 fused map-ROI FoveaStream). The
// materializer advertises the C-20 max-footprint pipe, loads the PLAIN
// persisted calibration (undistorted-coordinate crops when calibrated), and
// attaches B's native producer; teardown detaches + drops. Camera source =
// the LEASED handle only (a fovea is composable only while its camera lives —
// unleased compose fails loudly, never acquires). `pipeBroker` is referenced
// lazily (materialize runs long after module init — no TDZ).
// The fovea crop brick's native surface. These NAPIs are declared in
// `core/Aravis`'s d.ts, so we take the REAL types via a `typeof Aravis` Pick
// instead of a hand-mirrored `as unknown as {…}` shadow interface — a d.ts
// drift now fails vue-tsc here rather than passing silently.
const aravisFovea: Pick<
  typeof Aravis,
  "attachFoveaPipe" | "setFoveaRect" | "detachFoveaPipe"
> = Aravis;
// Unified-topology §5: fovea slots CHAIN on the camera's shared undistort
// brick (else the shared converter — uncalibrated degrade). No per-fovea cal
// loading: undistortion happens ONCE upstream; the fused map-ROI path and
// the legacy Camera-source private chains have no production callers left.
const foveaMaterializer = createFoveaMaterializer({
  pipes: () => pipeBroker, // lazy — materialize runs long after init
  brick: {
    attach: (src, id, opts) => aravisFovea.attachFoveaPipe(src, id, opts),
    detach: (id) => aravisFovea.detachFoveaPipe(id),
  },
});

const pipeBroker = pipeSession({
  broker: asBroker(Pipe),
  // C-24 step 3 (compose protocol): authoritative caller identity + destroy
  // signal from A-34 window tagging.
  windowIdOf: (ch) => hub.windowIdOf(ch),
  onWindowClosed: (fn) => hub.onWindowClosed(fn),
  // value-sweep-2026-07-11 (`pipe-consumer-refcount-no-reconciliation`):
  // reconcile leaked raw connect refcounts when a renderer port closes.
  onChannelClosed: (fn) => hub.onChannelClosed(fn),
  materializers: { fovea: foveaMaterializer },
});
hub.add(pipeBroker.session);
setRegistryPipeSeam({
  advertise: pipeBroker.advertise,
  unadvertise: pipeBroker.unadvertise,
  attach: (camera, pipeId) => void Aravis.attachCameraPipe(camera, pipeId),
  detach: (pipeId) => void Aravis.detachCameraPipe(pipeId),
});
// real-1g (C-23/B-23): the SESSION-advertised `undistort:<serial>` pipes —
// B's native remap producer (camera → convert → precomputed-map remap →
// FrameSink), attached with the plain persisted calibration record; B rebuilds
// the maps natively. The seam types camera/cal as `unknown` (so it unit-tests
// without the native core) — this local cast bridges to the typed NAPI surface.
const aravisUndistort = Aravis as unknown as {
  attachUndistortPipe(camera: unknown, pipeId: string, cal: unknown): void;
  detachUndistortPipe(pipeId: string): void;
};
const undistortSeam = {
  advertise: pipeBroker.advertise,
  unadvertise: pipeBroker.unadvertise,
  attach: (camera: unknown, pipeId: string, cal: unknown) =>
    aravisUndistort.attachUndistortPipe(camera, pipeId, cal),
  detach: (pipeId: string) => aravisUndistort.detachUndistortPipe(pipeId),
} as import("./undistort-pipe.js").UndistortPipeSeam;
// A-24 Stage 3: fold every live SHM pipe producer's native meter into
// `perfSnapshot.workloads` (probed out-of-loop; `ProbeSnapshot` === the JS
// `WorkloadSnapshot` shape). The 1d KCF tracker registers its own probe from
// the tracking session.
registerNativeProbe(
  () => Pipe.probeAll() as unknown as Record<string, WorkloadSnapshot>,
);
// real-1e (B-18): the per-camera BGRA converter threads — a sibling probe, one
// `converter:<target>` row per active converter (absent when parked/detached).
registerNativeProbe(
  () => Aravis.converterProbeAll() as unknown as Record<string, WorkloadSnapshot>,
);
// real-1g (B-23): the per-camera undistort threads — same sibling-probe shape,
// one `undistort:<format>` row per active undistort pipe (absent when parked).
registerNativeProbe(
  () => Aravis.undistortProbeAll() as unknown as Record<string, WorkloadSnapshot>,
);
// Unified-topology §6 REAL-REPORT layer: every live native brick self-reports
// its NodeReport (convert ← camera, undistort ← convert, fovea ← undistort —
// ACTUAL chain inputs). These rows REPLACE the fold's adapter synthesis by id,
// so the graph shows real wiring wherever a brick reports.
registerNodeReports(
  () => Topology.report() as unknown as import("@lib/orchestrator/graph-contract.js").NodeReport[],
);

// --- live camera view: frame-path validation slice -----------------------
const liveview = hub.add(liveViewSession());

// --- manage-cameras: per-camera config + preview -------------------------
const manageCameras = hub.add(manageCamerasSession());

// --- controller: serial MEMS mirror device (dormant until `connect`) ------
// Create the long-lived controller NODE up front (controller-node-and-fifo-
// edges §3): registers its `controller` graph node BEFORE any session's
// PID/position edges, so the declared node (with the serial-meter statsKey)
// wins over a synthesized placeholder. The session binds/unbinds the device.
controllerNode();
hub.add(controllerSession());

// capture-recorder-nodes Phase 1/2: the full-bit-depth `camera/<serial>/raw`
// pipes the recorder node FIFO-consumes (Aravis.attachRawPipe publishes
// `frame->raw` verbatim; consumer-gated like every pipe). Seam types the camera
// as `unknown` so the session/recorder unit-test without native core.
// Real d.ts types (both attach fns already type `camera` as `unknown` there,
// so the seam's opaque camera survives) — a `typeof Aravis` Pick, not a
// hand-mirrored shadow interface.
const aravisRaw: Pick<
  typeof Aravis,
  "attachRawPipe" | "detachRawPipe" | "attachRaw12pPipe" | "detachRaw12pPipe"
> = Aravis;
// Kind-routed seam: `"raw"` → the UNPACKED 16-bit container; `"raw12p"` → the
// VERBATIM packed wire payload (multi-fovea-recording ruling 1).
const rawSeam: import("./raw-pipe.js").RawPipeSeam = {
  advertise: pipeBroker.advertise,
  unadvertise: pipeBroker.unadvertise,
  attach: (kind, camera, pipeId) =>
    void (kind === "raw12p"
      ? aravisRaw.attachRaw12pPipe(camera, pipeId)
      : aravisRaw.attachRawPipe(camera, pipeId)),
  detach: (kind, pipeId) =>
    void (kind === "raw12p"
      ? aravisRaw.detachRaw12pPipe(pipeId)
      : aravisRaw.detachRawPipe(pipeId)),
};
// ONE process-wide refcounted registry (multi-fovea-recording ruling 5): shared
// by manual-control + multi-fovea so a live raw pipe id is advertised ONCE and
// shared, never clobbered by a second advertise.
const rawPipes = createRawPipeRegistry(rawSeam);

// --- manual-control: manual steering + capture + recording ----------------
// Constructed AFTER the stereo/heatmap/composite seams (below) so it can build
// its center-tile native views (disparity/anaglyph/sgbm; spec §views) — see its
// `hub.add` after the stereo seams are defined.

// --- multi-fovea: protocol-v2 multi-target logic skeleton ------------------
// Wave I-2 seams: the PAIRING brick factory (pairing-nodes P-1 — always-running
// per-stage L/R joins) + the zlib COMPRESSION brick (multi-fovea-recording
// ruling 9 — optional per-stream, the recorder consumes the /zlib sibling).
const aravisPair = Aravis as unknown as {
  createPairStream(
    leftId: string,
    rightId: string,
    options?: unknown,
  ): import("./pair-pipe.js").PairHandle;
  attachCompressPipe(
    sourcePipeId: string,
    pipeId: string,
    options?: { level?: number },
  ): boolean;
  detachCompressPipe(pipeId: string): boolean;
  compressProbeAll(): Record<string, unknown>;
};
const pairSeam: import("./pair-pipe.js").PairPipeSeam = (leftId, rightId, options) =>
  aravisPair.createPairStream(leftId, rightId, options);
const compressSeam: import("./compress-pipe.js").CompressPipeSeam = {
  advertise: pipeBroker.advertise,
  unadvertise: pipeBroker.unadvertise,
  attach: (src, id, opts) => void aravisPair.attachCompressPipe(src, id, opts),
  detach: (id) => void aravisPair.detachCompressPipe(id),
};
// Compression brick meters — same sibling-probe shape as the other bricks.
registerNativeProbe(
  () => aravisPair.compressProbeAll() as unknown as Record<string, WorkloadSnapshot>,
);
// The multi-fovea session is constructed AFTER `stereoSeam` (below) so it can
// receive the paired-SGBM seam (stereo-paired-inputs) — see its `hub.add` after
// the stereo seams are defined.

// --- disparity-scope: auto-vergence control loop (§7.1 S1a; split-node
// topology per docs/proposals/split-disparity-nodes.md) ---------------------
// The session composes GENERAL-PURPOSE bricks: slice (the fovea crop brick
// under session-owned ids) + scale (the ScaleStream brick) + template-match
// workers. Seams injected so the session unit-tests without native core.
// Real d.ts types (`ScaleParams` matches the seam's own union) via a `typeof
// Aravis` Pick — no hand-mirrored shadow interface.
const aravisScale: Pick<
  typeof Aravis,
  "attachScalePipe" | "setScaleParams" | "detachScalePipe" | "scaleProbeAll"
> = Aravis;
const sliceSeam: import("./slice-pipe.js").SlicePipeSeam = {
  advertise: pipeBroker.advertise,
  unadvertise: pipeBroker.unadvertise,
  attach: (src, id, opts) => aravisFovea.attachFoveaPipe(src, id, opts),
  steer: (id, rect) => void aravisFovea.setFoveaRect(id, rect),
  detach: (id) => aravisFovea.detachFoveaPipe(id),
};
const scaleSeam: import("./scale-pipe.js").ScalePipeSeam = {
  advertise: pipeBroker.advertise,
  unadvertise: pipeBroker.unadvertise,
  attach: (src, id, params) => aravisScale.attachScalePipe(src, id, params),
  retune: (id, params) => void aravisScale.setScaleParams(id, params),
  detach: (id) => aravisScale.detachScalePipe(id),
};
// The scale bricks' meters — same sibling-probe shape as converter/undistort/
// fovea (keys = node ids, folded onto the graph badges).
registerNativeProbe(
  () => aravisScale.scaleProbeAll() as unknown as Record<string, WorkloadSnapshot>,
);
// Stereo SGBM + heatmap bricks (stereo-disparity-and-heatmap-nodes): the
// center view's on-demand disparity chain. Same cast/seam/probe pattern.
const aravisStereo = Aravis as unknown as {
  attachStereoPipe(
    leftPipeId: string,
    rightPipeId: string,
    pipeId: string,
    params: unknown,
  ): void;
  attachStereoPaired(pairStage: string, pipeId: string, params: unknown): void;
  setStereoParams(pipeId: string, params: unknown): boolean;
  detachStereoPipe(pipeId: string): void;
  stereoProbeAll(): Record<string, unknown>;
  attachHeatmapPipe(sourcePipeId: string, pipeId: string, params: unknown): void;
  setHeatmapParams(pipeId: string, params: unknown): boolean;
  detachHeatmapPipe(pipeId: string): void;
  heatmapProbeAll(): Record<string, unknown>;
  attachCompositePipe(
    leftPipeId: string,
    rightPipeId: string,
    pipeId: string,
    params: unknown,
  ): void;
  setCompositeParams(pipeId: string, params: unknown): boolean;
  detachCompositePipe(pipeId: string): void;
  compositeProbeAll(): Record<string, unknown>;
};
const stereoSeam: import("./stereo-pipe.js").StereoPipeSeam = {
  advertise: pipeBroker.advertise,
  unadvertise: pipeBroker.unadvertise,
  attach: (l, r, id, params) => aravisStereo.attachStereoPipe(l, r, id, params),
  attachPaired: (stage, id, params) => aravisStereo.attachStereoPaired(stage, id, params),
  retune: (id, params) => void aravisStereo.setStereoParams(id, params),
  detach: (id) => aravisStereo.detachStereoPipe(id),
};
const heatmapSeam: import("./heatmap-pipe.js").HeatmapPipeSeam = {
  advertise: pipeBroker.advertise,
  unadvertise: pipeBroker.unadvertise,
  attach: (src, id, params) => aravisStereo.attachHeatmapPipe(src, id, params),
  retune: (id, params) => void aravisStereo.setHeatmapParams(id, params),
  detach: (id) => aravisStereo.detachHeatmapPipe(id),
};
const compositeSeam: import("./composite-pipe.js").CompositePipeSeam = {
  advertise: pipeBroker.advertise,
  unadvertise: pipeBroker.unadvertise,
  attach: (l, r, id, params) => aravisStereo.attachCompositePipe(l, r, id, params),
  retune: (id, params) => void aravisStereo.setCompositeParams(id, params),
  detach: (id) => aravisStereo.detachCompositePipe(id),
};
registerNativeProbe(
  () => aravisStereo.stereoProbeAll() as unknown as Record<string, WorkloadSnapshot>,
);
registerNativeProbe(
  () => aravisStereo.heatmapProbeAll() as unknown as Record<string, WorkloadSnapshot>,
);
registerNativeProbe(
  () => aravisStereo.compositeProbeAll() as unknown as Record<string, WorkloadSnapshot>,
);

// --- manual-control: manual steering + capture + recording ----------------
// Center-tile native views (spec §views) share the disparity-scope seams.
const manualControl = hub.add(
  manualControlSession(
    asBroker(Pipe),
    undistortSeam,
    rawPipes,
    stereoSeam,
    heatmapSeam,
    compositeSeam,
  ),
);

// --- multi-fovea: protocol-v2 multi-target logic skeleton ------------------
// Constructed here (not with its sibling seams above) so the paired-SGBM seam
// (stereo-paired-inputs — the `pair/undistort` disparity node) is available.
const multiFovea = hub.add(
  multiFoveaSession(
    asBroker(Pipe),
    undistortSeam,
    (pipeId, rect) => aravisFovea.setFoveaRect(pipeId, rect),
    {
      rawPipes,
      pair: pairSeam,
      compress: compressSeam,
      stereo: stereoSeam,
      // Notify main so the viewer window auto-opens the finished `.fovea`.
      finished: (foveaPath) =>
        process.parentPort?.postMessage({ type: "recording:finished", path: foveaPath }),
    },
  ),
);

const disparityScope = hub.add(
  disparityScopeSession(
    asBroker(Pipe),
    undistortSeam,
    sliceSeam,
    scaleSeam,
    stereoSeam,
    heatmapSeam,
    compositeSeam,
    rawPipes,
    // record_compression="zlib": route ALL recorded raw streams through the
    // per-frame zlib brick (the recorder consumes the /zlib sibling).
    compressSeam,
  ),
);

// --- split-tracking: two INDEPENDENT single-eye visual servos (calibrate-
// extrinsic scaffold + per-eye disparity-scope tracker/Jacobian). Owns the
// triple; mirrors what manual-control/calibrate-extrinsic receive: the pipe
// broker, the undistort seam (L/R homography + C intrinsic pipes), the shared
// raw-pipe registry (capture + recording), and the zlib compress seam.
const splitTracking = hub.add(
  splitTrackingSession(asBroker(Pipe), undistortSeam, rawPipes, compressSeam),
);

// --- calibrate-intrinsic: per-camera checkerboard/marker calibration (§7.1 S1b)
const calibrateIntrinsic = hub.add(
  calibrateIntrinsicSession(asBroker(Pipe), rawPipes, compressSeam),
);

// --- calibrate-drift: per-fovea drift measurement (§7.1 S1b) --------------
const calibrateDrift = hub.add(calibrateDriftSession(asBroker(Pipe), rawPipes, compressSeam));

// --- calibrate-distortion: projector-alignment/homography check (§7.1 S1b)
const calibrateDistortion = hub.add(
  calibrateDistortionSession(asBroker(Pipe), rawPipes, compressSeam),
);

// --- calibrate-extrinsic: extrinsic calibration wizard (§7.1 S1b) --------
const calibrateExtrinsic = hub.add(
  calibrateExtrinsicSession(asBroker(Pipe), rawPipes, compressSeam),
);

// The former `viewer` session (C-8) is RETIRED (standalone-viewer-and-fcap
// ruling 1): container playback now lives entirely inside the viewer window
// (src/viewer/worker.ts via preload-viewer) and never touches this process —
// playback survives orchestrator restarts by construction.

// Camera-owning sessions — the force-idle set shared by `system.releaseCameras`
// (§12.3 R4) and the multi-window drain path below.
const cameraOwning: ServerSession<any>[] = [
  liveview,
  manageCameras,
  manualControl,
  multiFovea,
  disparityScope,
  splitTracking,
  calibrateIntrinsic,
  calibrateDrift,
  calibrateDistortion,
  calibrateExtrinsic,
];

// --- system: process-wide concerns + camera handoff for non-migrated modules
const system = hub.add(
  systemSession(
    () => cameraOwning,
    () => hub.frameStatsSnapshot(),
    // C-24: the live node graph rides perfSnapshot (ruled Q2) — pipes from the
    // native enumerator (item 2, exact bytesTotal for MB/s), stats from the
    // same probed workloads map, session wiring via registerGraphWiring, and
    // the REAL-REPORT layer (Topology.report() + any registered JS sources)
    // replacing adapter synthesis by id (unified-topology §6).
    (workloads) =>
      buildTopology({
        listPipes: () => Pipe.list(),
        workloads: () => workloads,
        reports: nodeReports,
      }),
  ),
);

// Disposable-orchestrator ruling 2: surface the hardware-clear WAIT as a named
// spin-up step on the `system` session so a subscribed app window shows WHY
// spin-up pauses (AppWindow observes system status alongside its own). The step
// appears only while an acquisition is actually blocked on the gate and clears
// the moment main grants hardware-clear.
const HW_WAIT_STEP = {
  id: "hardware-clear",
  label: "Waiting for previous session to release hardware…",
} as const;
let hwWaitMonitor: ReturnType<ServerSession<any>["progressMonitor"]> | null = null;
onHardwareWaitChange((waiting) => {
  if (waiting && !hwWaitMonitor) {
    hwWaitMonitor = system.progressMonitor([HW_WAIT_STEP]);
    hwWaitMonitor.start(HW_WAIT_STEP.id);
  } else if (!waiting && hwWaitMonitor) {
    hwWaitMonitor.complete();
    hwWaitMonitor = null;
  }
});

if (Number.isFinite(forkTs)) span("boot.sessionsRegistered", Date.now() - forkTs);

// --- multi-window drain (docs/history/refactor/multi-window.md §3) -----------------
// Main asks us to idle every camera-owning session before spawning the next
// app window ("closed" = session-idle-drained, not window-destroyed). Refuse
// — draining NOTHING — if any session reports busy (mid-capture/recording);
// otherwise dispose all, await their async idles (V1-class drains), and let
// `releaseAll()` backstop any handle outside session control (same order as
// `system.releaseCameras`).
async function drainForWindowSwitch(): Promise<{ ok: boolean; reason?: string }> {
  for (const s of cameraOwning) {
    const reason = s.busyReason();
    if (reason) return { ok: false, reason: `${s.name}: ${reason}` };
  }
  for (const s of cameraOwning) s.dispose();
  await Promise.all(cameraOwning.map((s) => s.drained()));
  await releaseAll();
  return { ok: true };
}

// --- hardware quiescence (docs/hardware/stage-f.md safety invariant) -------
// The MEMS controller must never stay energized and no camera may stay
// streaming past this process's life, no matter how it ends. This is the
// GRACEFUL half: an awaited disable + release, run on main's `shutdown`
// message (app quit) and on uncaught errors. The crash half (SIGABRT/SIGSEGV,
// where nothing here runs) is main's janitor process — it fires whenever we
// exit without posting `quiesced` below.
async function quiesceHardware(): Promise<void> {
  try {
    const c = activeController();
    setActiveController(null);
    if (c?.connected) {
      await c.disable(); // energized mirrors first, cameras after
      c.release();
    }
  } catch (e) {
    console.error("[shutdown] MEMS disable failed:", e);
  }
  try {
    await releaseAll();
  } catch (e) {
    console.error("[shutdown] camera release failed:", e);
  }
}

/** Drain camera-owning sessions best-effort, then disarm all hardware. Shared
 *  by the graceful (shutdown) and cold (crash/SIGTERM) paths. */
async function drainAndQuiesce(): Promise<void> {
  const deadline = new Promise<void>((r) => setTimeout(r, 4000));
  try {
    for (const s of cameraOwning) s.dispose();
    await Promise.race([
      Promise.all(cameraOwning.map((s) => s.drained())),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch {
    /* drain is best-effort on the way out */
  }
  await Promise.race([quiesceHardware(), deadline]);
}

let quiescing = false;
/** GRACEFUL shutdown (main's `shutdown` message): drain, disarm hardware, then
 *  post the clean-exit ACK and WAIT — main reaps us (kill) once it records the
 *  ack. NOT self-exiting is deliberate: a still-running process cannot drop the
 *  queued `quiesced` message, so main's clean/crash decision is deterministic
 *  without the old flush-sleep + code===0 fallback (lifecycle ruling 3/4). */
function quiesceAndAck(): void {
  if (quiescing) return;
  quiescing = true;
  void (async () => {
    await drainAndQuiesce();
    try {
      process.parentPort.postMessage({ type: "quiesced" });
    } catch {
      /* parent may already be gone */
    }
    // No process.exit here — main's kill() (→ SIGTERM below) reaps us after it
    // has the ack.
  })();
}

/** COLD / CRASH exit: disarm hardware, then die. Posts NO ack, so main treats
 *  the exit as crash/killed and its janitor backstops. Used by uncaught JS
 *  errors and a cold SIGTERM (killed without a prior `shutdown`). */
function quiesceAndExit(code: number): void {
  if (quiescing) return;
  quiescing = true;
  void (async () => {
    await drainAndQuiesce();
    shutdown();
    process.exit(code);
  })();
}

// Headless PARK is RETIRED (disposable-orchestrator ruling 5): with no app
// window there is no hardware instance at all — the process is disposed on the
// last owned window's close, so there is nothing to park. The enumerate-only
// probe (orchestrator/probe.ts) holds no hardware and feeds Welcome instead.

// A JS-level CRASH must still leave the hardware safe — quiesce, then die
// nonzero (main's janitor stays as the backstop for native aborts, which
// never reach these handlers).
process.on("uncaughtException", (err) => {
  console.error("[orchestrator] uncaughtException:", err);
  quiesceAndExit(1);
});
// A rejection is NOT a crash: teardown paths (worker termination, dropped
// pipes on app exit) reject benignly, and Electron's utilityProcess default
// was warn-and-continue. Exiting here turned every sub-app exit into an
// orchestrator death + janitor sweep (rig 2026-07-08) — log loudly, surface
// to renderers, keep running.
process.on("unhandledRejection", (reason) => {
  console.error("[orchestrator] unhandledRejection:", reason);
  hub.reportError("unhandledRejection", String(reason));
});

// --- accept renderer connections brokered by the main process ------------
let firstPort = true;
process.parentPort.on("message", (e) => {
  const data = e.data as
    | { type?: string; id?: number; windowId?: string | null }
    | null;
  if (data?.type === "shutdown") {
    quiesceAndAck();
    return;
  }
  // Disposable-orchestrator gate (ruling 2): main confirmed the previous
  // hardware instance released the devices — open the acquisition gate. Deferred
  // camera-owning activations + controller.connect proceed from here.
  if (data?.type === "hardware-clear") {
    signalHardwareClear();
    return;
  }
  if (data?.type === "window:drain") {
    const id = data.id ?? 0;
    void drainForWindowSwitch()
      .catch((err) => ({ ok: false, reason: String(err) }))
      .then((result) =>
        process.parentPort.postMessage({ type: "window:drain-result", id, ...result }),
      );
    return;
  }
  // A-34: main reports a BrowserWindow destroyed — the authoritative teardown
  // signal for per-window state (`win/<windowId>/...`, C-24 composition).
  if (data?.type === "window:closed") {
    if (typeof data.windowId === "string") hub.windowClosed(data.windowId);
    return;
  }
  if (firstPort && e.ports.length > 0) {
    firstPort = false;
    if (Number.isFinite(forkTs)) span("boot.firstPortAttached", Date.now() - forkTs);
  }
  // A-34: the connect handoff carries the sender window's stable id — the Hub
  // tags each channel so sessions can key per-window behavior on it.
  for (const port of e.ports) hub.attach(port, { windowId: data?.windowId });
});

// Orderly shutdown: release session resources (cameras, serial, intervals) then
// the native module. `core` is imported eagerly so `cleanup()` is synchronous —
// the prior `process.on("exit", () => import(...))` could not complete an async
// import as the process was tearing down.
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  hub.shutdown();
  cleanup?.();
}
process.on("SIGTERM", () => {
  // main's REAP signal. After a graceful `shutdown` we already drained,
  // disarmed, and posted `quiesced` (the process idled waiting for this) — so
  // just exit cleanly. A COLD SIGTERM (killed without a prior `shutdown`)
  // disarms first; main's janitor still backstops a wedge. Either way the
  // ack-based decision main already made stands (code is ignored there).
  if (quiescing) {
    shutdown();
    process.exit(0);
  } else {
    quiesceAndExit(0);
  }
});
process.on("exit", shutdown);
