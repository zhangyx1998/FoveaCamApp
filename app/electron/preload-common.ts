// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
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
