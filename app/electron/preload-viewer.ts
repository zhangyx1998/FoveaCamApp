// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Viewer-window preload (standalone-viewer-and-fcap ruling 1): the shared
// bridge + the viewer's OWN playback worker. The viewer does NOT interface
// with the orchestrator — no shm reader, no session port; instead this
// preload spawns the bundled `viewer-worker.js` (a `worker_threads.Worker`
// hosting MCAP read + core-Vision decode + paced playback, see
// src/viewer/worker.ts) and relays it to the main world over a DOM
// MessagePort.
//
// MECHANISM (why this shape): the window class stays `sandbox: false` with
// `contextIsolation: true` — Node lives HERE, not in the page. The renderer
// hands a `MessageChannel` port via `window.postMessage({kind: VIEWER_INIT})`
// (the established SHM_INIT pattern; a DOM port is the only transferable-
// capable channel across the isolated-world boundary), and this preload
// relays verbatim both ways, re-transferring frame buffers on each hop —
// decode output crosses preload → renderer with zero copies. worker_threads
// (not a renderer Web Worker) because decode needs the native `core` addon
// and Node fs — and it keeps the UI thread untouched.
//
// One worker per window (one window per file — main.ts dedupes). A second
// VIEWER_INIT (dev full-reload) terminates the stale worker first.
import path from "node:path";
import { installBridge } from "./preload-bridge";
import { VIEWER_INIT, type ViewerEvent } from "../src/viewer/protocol";

// Emitted as self-contained CJS (see preload-bridge.ts header / V11): the
// module wrapper's own `require`/`__dirname` are available at runtime.
declare const require: NodeRequire;
declare const __dirname: string;

const { Worker } =
  require("node:worker_threads") as typeof import("node:worker_threads");

// The bundled worker entry lands next to this preload in `.dist/electron/`
// (vite.config.ts main-entry map — same pattern as vision-worker.js).
const WORKER_PATH = path.join(__dirname, "viewer-worker.js");

let worker: InstanceType<typeof Worker> | null = null;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data as { kind?: string } | undefined;
  if (msg?.kind !== VIEWER_INIT) return;
  const port = event.ports[0];
  if (!port) return;

  void worker?.terminate(); // dev full-reload: replace the stale worker
  const w = new Worker(WORKER_PATH);
  worker = w;

  w.on("message", (ev: ViewerEvent) => {
    // Re-transfer frame buffers onto the DOM port (zero-copy second hop).
    const transfer = ev?.type === "frame" ? [ev.buffer] : [];
    port.postMessage(ev, transfer);
  });
  w.on("error", (error) => {
    port.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    } satisfies ViewerEvent);
  });
  port.onmessage = (m) => w.postMessage(m.data);
  port.start();
});

// The worker dies with the renderer process anyway; terminating on pagehide
// just releases the file handle promptly (close-window ≠ process-exit in
// every path, e.g. dev navigation).
window.addEventListener("pagehide", () => {
  void worker?.terminate();
  worker = null;
});

installBridge();
