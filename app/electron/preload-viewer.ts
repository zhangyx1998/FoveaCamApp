// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Viewer-window preload (standalone-viewer-and-fcap ruling 1, AS SHIPPED
// amendment). It USED to fork the playback worker in-process (a
// `worker_threads.Worker`) and relay it to the page — but an Electron RENDERER
// process cannot construct Node workers ("The V8 platform used by this instance
// of Node does not support creating Workers"), so that path never worked. The
// engine now lives in a MAIN-owned `utilityProcess` (see src/viewer/worker.ts,
// forked in main.ts exactly like the orchestrator); this preload is reduced to
// two jobs:
//   1. the shared `foveaBridge` (which exposes `spawnViewerEngine(file)` →
//      `viewer:spawn` and `onViewerEngineDown`), and
//   2. relaying the brokered `MessagePort` from main into the page.
//
// PORT RELAY (mirrors preload-bridge's `orchestrator:port`): main delivers the
// renderer end of the engine channel via `webContents.postMessage("viewer:port",
// null, [port])`; that arrives HERE on `ipcRenderer` (a preload/isolated-world
// context). A DOM `MessagePort` can't cross `contextBridge` as a value, so we
// hand it to the main world via `window.postMessage` — ViewerWindow.vue listens
// for `"viewer:port"` on the DOM `message` event. No worker, no re-transfer:
// the renderer now talks to the engine over ONE port.
import { ipcRenderer } from "electron";
import { installBridge } from "./preload-bridge";

ipcRenderer.on("viewer:port", (e) => {
  window.postMessage("viewer:port", "*", e.ports);
});

installBridge();
