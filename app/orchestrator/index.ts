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

import { cleanup } from "core";
import { Hub } from "./runtime.js";
import { onReport } from "./diagnostics.js";
import { systemSession } from "./sessions/system.js";
import { controllerSession } from "./sessions/controller.js";
import liveViewSession from "@modules/single-capture/session";
import manageCamerasSession from "@modules/manage-cameras/session";
import trackingSession from "@modules/tracking-single/session";
import manualControlSession from "@modules/manual-control/session";

const hub = new Hub();

// Forward process-wide diagnostics (registry sink-throw isolation, etc.) to
// every connected renderer, so failures are visible without watching the
// orchestrator console. See docs/refactor/orchestrator.md §12.1 C7.
onReport((scope, message) => hub.reportError(scope, message));

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

// --- system: process-wide concerns + camera handoff for non-migrated modules
hub.add(
  systemSession(
    () => [liveview, manageCameras, tracking, manualControl],
    () => hub.frameStatsSnapshot(),
  ),
);

// --- accept renderer connections brokered by the main process ------------
process.parentPort.on("message", (e) => {
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
