// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared `foveaBridge` installer for every preload entry. Preloads run in
// their own isolated JS context regardless of the window's contextIsolation
// setting; the orchestrator MessagePort can't cross `contextBridge` as a
// function argument (structured-clone limits on the bridge itself), so it's
// handed into the main world via `window.postMessage` —
// `lib/orchestrator/client.ts` listens for it on the DOM `message` event.
//
// Sharing this module across preload entries is safe ONLY because each entry
// is bundled by its own build pass (vite.config.ts `preloadBuild()` — one
// low-level vite-plugin-electron item per entry), so it gets inlined into
// each output. A single multi-entry rollup pass would split this file into a
// sibling chunk, and sandboxed preloads cannot require sibling chunks (V11).
import { contextBridge, ipcRenderer } from "electron";
import type { FoveaBridge } from "./bridge";

export function installBridge(extra: Partial<FoveaBridge> = {}) {
  ipcRenderer.on("orchestrator:port", (e) => {
    window.postMessage("orchestrator:port", "*", e.ports);
  });

  const bridge: FoveaBridge = {
    connectOrchestrator: () => ipcRenderer.send("orchestrator:connect"),
    onOrchestratorDown: (cb) => {
      ipcRenderer.on("orchestrator:down", () => cb());
    },
    openProfilerWindow: () => ipcRenderer.send("open-profiler-window"),
    openAppWindow: (appId) => ipcRenderer.send("window:open-app", appId),
    openProjectionWindow: (session, frame) =>
      ipcRenderer.send("window:open-projection", session, frame),
    onFullscreenChange: (cb) => {
      ipcRenderer.on("window:fullscreen", (_e, fullscreen: boolean) =>
        cb(fullscreen),
      );
    },
    onRecorderTrigger: (cb) => {
      ipcRenderer.on("recorder:trigger", () => cb());
    },
    resolvePath: (...segments) => ipcRenderer.invoke("save-path:resolve", segments),
    resolveDefaultSavePath: (directory) =>
      ipcRenderer.invoke("save-path:resolve-default", directory),
    pathExists: (path) => ipcRenderer.invoke("fs:exists", path),
    validateWritablePath: (path) => ipcRenderer.invoke("fs:validate-writable", path),
    writePerfSnapshot: (content) => ipcRenderer.invoke("perf-snapshot:write", content),
    ...extra,
  };

  contextBridge.exposeInMainWorld("foveaBridge", bridge);
}
