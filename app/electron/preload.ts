// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Preload always runs in its own isolated JS context, regardless of the
// window's `contextIsolation` setting — so this is the one place both modes
// share, and the natural spot to land the contextIsolation-compatible
// surface ahead of the actual flip (docs/refactor/orchestrator.md §7.1 T5).
//
// The orchestrator `MessagePort` can't cross `contextBridge` as a function
// argument (structured-clone limits on the bridge itself) — the standard
// pattern is to `window.postMessage` it into the main world instead, which
// works whether or not that world is isolated. `lib/orchestrator/client.ts`
// listens for it via `window.addEventListener("message", ...)`.
//
// ⚠ KEEP SELF-CONTAINED. This entry runs under `sandbox: true` (profiler
// window always; main window when FOVEA_SHM_STREAMS is off), and sandboxed
// preloads CANNOT require sibling chunks — any runtime module shared with
// another preload entry gets split into a chunk by rollup and kills the
// load with "module not found" (V11). The bridge below is intentionally
// duplicated in `preload-shm.ts` — keep the two copies in sync by hand.
import { contextBridge, ipcRenderer } from "electron";
import type { FoveaBridge } from "./bridge";

ipcRenderer.on("orchestrator:port", (e) => {
  window.postMessage("orchestrator:port", "*", e.ports);
});

const bridge: FoveaBridge = {
  connectOrchestrator: () => ipcRenderer.send("orchestrator:connect"),
  onOrchestratorDown: (cb) => {
    ipcRenderer.on("orchestrator:down", () => cb());
  },
  openProfilerWindow: () => ipcRenderer.send("open-profiler-window"),
  resolvePath: (...segments) => ipcRenderer.invoke("save-path:resolve", segments),
  resolveDefaultSavePath: (directory) =>
    ipcRenderer.invoke("save-path:resolve-default", directory),
  pathExists: (path) => ipcRenderer.invoke("fs:exists", path),
  validateWritablePath: (path) => ipcRenderer.invoke("fs:validate-writable", path),
  writePerfSnapshot: (content) => ipcRenderer.invoke("perf-snapshot:write", content),
};

contextBridge.exposeInMainWorld("foveaBridge", bridge);
