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
// no single owning UI module. See docs/refactor/orchestrator.md §12.3 R1.

import { Shm, cleanup } from "core";
import {
  createShmFrameTransport,
  type ShmApi,
} from "./frame-transport.js";
import { Hub, setFrameTransportFactory } from "./runtime.js";
import { onReport, onSpan, span } from "./diagnostics.js";
import { systemSession } from "./sessions/system.js";
import { controllerSession } from "./sessions/controller.js";
import liveViewSession from "@modules/single-capture/session";
import manageCamerasSession from "@modules/manage-cameras/session";
import trackingSession from "@modules/tracking-single/session";
import manualControlSession from "@modules/manual-control/session";
import multiFoveaSession from "@modules/multi-fovea/session";
import disparityScopeSession from "@modules/disparity-scope/session";
import calibrateIntrinsicSession from "@modules/calibrate-intrinsic/session";
import calibrateDriftSession from "@modules/calibrate-drift/session";
import calibrateDistortionSession from "@modules/calibrate-distortion/session";
import calibrateExtrinsicSession from "@modules/calibrate-extrinsic/session";

// S5 (docs/refactor/orchestrator.md §7.1): boot phase timing. `FOVEA_FORK_TS`
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

// Forward process-wide diagnostics (registry sink-throw isolation, etc.) to
// every connected renderer, so failures are visible without watching the
// orchestrator console. See docs/refactor/orchestrator.md §12.1 C7.
onReport((scope, message) => hub.reportError(scope, message));
// Same pattern for structured timing spans (§7.1 S5) — live broadcast so a
// future profiler window can render a timeline without polling.
onSpan((s) => hub.reportSpan(s));

// --- live camera view: frame-path validation slice -----------------------
const liveview = hub.add(liveViewSession());

// --- manage-cameras: per-camera config + preview -------------------------
const manageCameras = hub.add(manageCamerasSession());

// --- controller: serial MEMS mirror device (dormant until `connect`) ------
hub.add(controllerSession());

// --- tracking: first frame-driven control loop (KCF + actuation) ----------
const tracking = hub.add(trackingSession());

// --- manual-control: manual steering + capture + recording ----------------
const manualControl = hub.add(manualControlSession());

// --- multi-fovea: protocol-v2 multi-target logic skeleton ------------------
const multiFovea = hub.add(multiFoveaSession());

// --- disparity-scope: auto-vergence control loop (§7.1 S1a) ---------------
const disparityScope = hub.add(disparityScopeSession());

// --- calibrate-intrinsic: per-camera checkerboard/marker calibration (§7.1 S1b)
const calibrateIntrinsic = hub.add(calibrateIntrinsicSession());

// --- calibrate-drift: per-fovea drift measurement (§7.1 S1b) --------------
const calibrateDrift = hub.add(calibrateDriftSession());

// --- calibrate-distortion: projector-alignment/homography check (§7.1 S1b)
const calibrateDistortion = hub.add(calibrateDistortionSession());

// --- calibrate-extrinsic: extrinsic calibration wizard (§7.1 S1b) --------
const calibrateExtrinsic = hub.add(calibrateExtrinsicSession());

// --- system: process-wide concerns + camera handoff for non-migrated modules
hub.add(
  systemSession(
    () => [
      liveview,
      manageCameras,
      tracking,
      manualControl,
      multiFovea,
      disparityScope,
      calibrateIntrinsic,
      calibrateDrift,
      calibrateDistortion,
      calibrateExtrinsic,
    ],
    () => hub.frameStatsSnapshot(),
  ),
);

if (Number.isFinite(forkTs)) span("boot.sessionsRegistered", Date.now() - forkTs);

// --- accept renderer connections brokered by the main process ------------
let firstPort = true;
process.parentPort.on("message", (e) => {
  if (firstPort) {
    firstPort = false;
    if (Number.isFinite(forkTs)) span("boot.firstPortAttached", Date.now() - forkTs);
  }
  for (const port of e.ports) hub.attach(port);
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
  shutdown();
  process.exit(0);
});
process.on("exit", shutdown);
