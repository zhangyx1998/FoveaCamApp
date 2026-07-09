// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator process entry. Runs in an Electron `utilityProcess` — its event
// loop is NOT bound to any UI render loop, so `core` (acquisition, vision,
// control, hardware I/O) runs here with full async throughput. The main process
// hands us one `MessagePortMain` per renderer connection.
//
// Each feature session is co-located with its module (`modules/X/session.ts` +
// `contract.ts`, next to `index.vue`) — this file is just the registration
// list, plus the two cross-cutting sessions (`system`, `controller`) that have
// no single owning UI module. See docs/history/refactor/orchestrator.md §12.3 R1.

import { Shm, Pipe, Aravis, Topology, steadyNowNs, cleanup } from "core";
import { onClockMetrics } from "core/Aravis";
import { setHostClock } from "./time-align.js";
import { wireClockMetrics } from "./clock-calibration.js";
import {
  createShmFrameTransport,
  type ShmApi,
} from "./frame-transport.js";
import { Hub, setFrameTransportFactory, type ServerSession } from "./runtime.js";
import { releaseAll, setRegistryPipeSeam } from "./registry.js";
import { pipeSession, asBroker, createFoveaMaterializer } from "./pipe-session.js";
import { buildTopology } from "./graph-topology.js";
import { registerNativeProbe, registerNodeReports, nodeReports } from "./native-probes.js";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats.js";
import { onReport, onSpan, span } from "./diagnostics.js";
import { systemSession } from "./sessions/system.js";
import { controllerSession } from "./sessions/controller.js";
import { activeController, setActiveController } from "./controller.js";
import { controllerNode } from "./controller-node.js";
import { viewerSession } from "./sessions/viewer.js";
import liveViewSession from "@modules/single-capture/session";
import manageCamerasSession from "@modules/manage-cameras/session";
import manualControlSession from "@modules/manual-control/session";
import multiFoveaSession from "@modules/multi-fovea/session";
import disparityScopeSession from "@modules/disparity-scope/session";
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
const forkTs = Number(process.env.FOVEA_FORK_TS);
if (Number.isFinite(forkTs)) span("boot.forkToLoad", Date.now() - forkTs);

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
onReport((scope, message) => hub.reportError(scope, message));
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
const aravisFovea = Aravis as unknown as {
  attachFoveaPipe(
    sourcePipeId: string,
    pipeId: string,
    opts: { rect: { x: number; y: number; width: number; height: number } },
  ): void;
  setFoveaRect(
    pipeId: string,
    rect: { x: number; y: number; width: number; height: number },
  ): boolean;
  detachFoveaPipe(pipeId: string): void;
};
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

// --- manual-control: manual steering + capture + recording ----------------
const manualControl = hub.add(manualControlSession(asBroker(Pipe), undistortSeam));

// --- multi-fovea: protocol-v2 multi-target logic skeleton ------------------
const multiFovea = hub.add(
  multiFoveaSession(asBroker(Pipe), undistortSeam, (pipeId, rect) =>
    aravisFovea.setFoveaRect(pipeId, rect),
  ),
);

// --- disparity-scope: auto-vergence control loop (§7.1 S1a) ---------------
const disparityScope = hub.add(disparityScopeSession(asBroker(Pipe), undistortSeam));

// --- calibrate-intrinsic: per-camera checkerboard/marker calibration (§7.1 S1b)
const calibrateIntrinsic = hub.add(calibrateIntrinsicSession(asBroker(Pipe)));

// --- calibrate-drift: per-fovea drift measurement (§7.1 S1b) --------------
const calibrateDrift = hub.add(calibrateDriftSession());

// --- calibrate-distortion: projector-alignment/homography check (§7.1 S1b)
const calibrateDistortion = hub.add(calibrateDistortionSession(asBroker(Pipe)));

// --- calibrate-extrinsic: extrinsic calibration wizard (§7.1 S1b) --------
const calibrateExtrinsic = hub.add(calibrateExtrinsicSession());

// --- viewer: .fovea container playback (C-8) — no camera/serial, so NOT in
// the camera-owning drain set below (viewer windows survive app switches).
hub.add(viewerSession());

// Camera-owning sessions — the force-idle set shared by `system.releaseCameras`
// (§12.3 R4) and the multi-window drain path below.
const cameraOwning: ServerSession<any>[] = [
  liveview,
  manageCameras,
  manualControl,
  multiFovea,
  disparityScope,
  calibrateIntrinsic,
  calibrateDrift,
  calibrateDistortion,
  calibrateExtrinsic,
];

// --- system: process-wide concerns + camera handoff for non-migrated modules
hub.add(
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

let quiescing = false;
/** Graceful exit: drain sessions best-effort, quiesce hardware, confirm to
 *  main (suppresses its janitor), then exit. */
function quiesceAndExit(code: number): void {
  if (quiescing) return;
  quiescing = true;
  const deadline = new Promise<void>((r) => setTimeout(r, 4000));
  void (async () => {
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
    try {
      process.parentPort.postMessage({ type: "quiesced" });
    } catch {
      /* parent may already be gone */
    }
    // Give the parentPort pipe a beat to FLUSH the confirmation — exiting
    // right after postMessage can drop it, and a lost `quiesced` makes main
    // run the janitor after a perfectly clean shutdown.
    await new Promise((r) => setTimeout(r, 100));
    shutdown();
    process.exit(code);
  })();
}

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
    quiesceAndExit(0);
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
  // Best-effort async quiesce (MEMS disable is a serial write and cannot run
  // inside the sync `exit` handler). Main waits for our `quiesced`
  // confirmation before letting the app die; if we're reaped first, its
  // janitor covers the rest.
  quiesceAndExit(0);
});
process.on("exit", shutdown);
