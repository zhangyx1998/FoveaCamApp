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
import type {
  FoveaBridge,
  InvokeChannels,
  PushChannels,
  SendChannels,
} from "./bridge";

// Typed wrappers over the raw `ipcRenderer` surface, constrained by the shared
// channel registry (bridge.ts) — a bad channel name or arg tuple is a compile
// error here. All types-only imports (erased at build), so the emitted preload
// stays self-contained CJS with no sibling-chunk import (V11).
function invoke<K extends keyof InvokeChannels>(
  channel: K,
  ...args: InvokeChannels[K]["args"]
): Promise<InvokeChannels[K]["ret"]> {
  return ipcRenderer.invoke(channel, ...args);
}
function send<K extends keyof SendChannels>(channel: K, ...args: SendChannels[K]): void {
  ipcRenderer.send(channel, ...args);
}
function listen<K extends keyof PushChannels>(
  channel: K,
  cb: (...args: PushChannels[K]) => void,
): () => void {
  const wrapped = (_e: unknown, ...args: unknown[]) =>
    cb(...(args as PushChannels[K]));
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

export function installBridge(extra: Partial<FoveaBridge> = {}) {
  ipcRenderer.on("orchestrator:port", (e) => {
    window.postMessage("orchestrator:port", "*", e.ports);
  });

  const bridge: FoveaBridge = {
    connectOrchestrator: () => send("orchestrator:connect"),
    onOrchestratorDown: (cb) => listen("orchestrator:down", (report) => cb(report)),
    onProbeCameras: (cb) => listen("probe:cameras", (cameras) => cb(cameras)),
    openProfilerWindow: () => send("open-profiler-window"),
    openConfigWindow: () => send("window:open-config"),
    openTeleCanvasWindow: () => send("window:open-telecanvas"),
    applyTeleCanvas: (mode, port, url) => send("telecanvas:apply", mode, port, url),
    getTeleCanvasStatus: () => invoke("telecanvas:get-status"),
    onTeleCanvasStatus: (cb) => listen("telecanvas:status", (status) => cb(status)),
    getTeleCanvasTarget: () => invoke("telecanvas:get-target"),
    onTeleCanvasTarget: (cb) => listen("telecanvas:target", (target) => cb(target)),
    openAppWindow: (appId) => send("window:open-app", appId),
    openProjectionWindow: (pane) => send("window:open-projection", pane),
    toggleDebugWindow: (session, kind) => send("window:toggle-debug", session, kind),
    openDebugWindow: (session, kind) => send("window:open-debug", session, kind),
    onFullscreenChange: (cb) => listen("window:fullscreen", (fullscreen) => cb(fullscreen)),
    onRecorderTrigger: (cb) => listen("recorder:trigger", () => cb()),
    resolvePath: (...segments) => invoke("save-path:resolve", segments),
    resolveDefaultSavePath: (directory, base) =>
      invoke("save-path:resolve-default", directory, base),
    pathExists: (path) => invoke("fs:exists", path),
    validateWritablePath: (path) => invoke("fs:validate-writable", path),
    writePerfSnapshot: (content) => invoke("perf-snapshot:write", content),
    openPerfSnapshotFolder: () => invoke("perf-snapshot:open-folder"),
    revealPerfSnapshot: (file) => invoke("perf-snapshot:reveal", file),
    revealRecording: (file) => invoke("viewer:reveal", file),
    revealCrashFile: (file) => invoke("crash:reveal", file),
    setWindowPinned: (pinned) => send("window:set-pinned", pinned),
    spawnViewerEngine: (file) => send("viewer:spawn", file),
    onViewerEngineDown: (cb) => listen("viewer:engine-down", (message) => cb(message)),
    showExportSaveDialog: (defaultName, ext) => invoke("export:save-dialog", defaultName, ext),
    getAppSessionActive: () => invoke("app-session:active"),
    onAppSessionActive: (cb) => listen("app-session:active", (active) => cb(active)),
    setViewerExportsActive: (active) => send("viewer:exports-active", active),
    onViewerConfirmClose: (cb) => listen("viewer:confirm-close", () => cb()),
    confirmViewerClose: () => send("viewer:close-confirmed"),
    readStore: <T>(path: string[], fallback: T) =>
      invoke("store:read", path, fallback) as Promise<T>,
    readStoreOnce: <T>(path: string[], fallback: T) =>
      invoke("store:read-once", path, fallback) as Promise<T>,
    patchStore: (path, ops) => invoke("store:patch", path, ops),
    clearStore: (path) => invoke("store:clear", path),
    listStore: (path) => invoke("store:list", path),
    onStoreChanged: (cb) => listen("store:changed", (path, value) => cb(path, value)),
    trashStoreDoc: (path) => invoke("store:trash", path),
    showJsonSaveDialog: (defaultName) => invoke("dialog:save-json", defaultName),
    showJsonOpenDialog: () => invoke("dialog:open-json"),
    writeTextFile: (path, content) => invoke("fs:write-text", path, content),
    readTextFile: (path) => invoke("fs:read-text", path),
    ...extra,
  };

  contextBridge.exposeInMainWorld("foveaBridge", bridge);
}
