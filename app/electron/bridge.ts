// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The renderer's entire main-process surface once `contextIsolation: true` /
// `nodeIntegration: false` land (docs/history/refactor/orchestrator.md §7.1 T5 —
// T2's spike). Every method here is a thin `ipcRenderer` wrapper exposed via
// `contextBridge.exposeInMainWorld("foveaBridge", ...)` in `preload.ts`; the
// orchestrator `MessagePort` itself can't cross a bridge function call
// (structured-clone limits), so it's handed off separately via
// `window.postMessage` — see `preload.ts`'s `orchestrator:port` listener and
// `lib/orchestrator/client.ts`'s `connect()`.
//
// Kept intentionally narrow (path-string joins + existence/writability
// checks, not a general fs passthrough) even though none of it is a real
// security boundary today (the orchestrator process still trusts whatever
// path the renderer sends) — smaller surface is just less to keep in sync.
// TYPE-ONLY import (erased at build — keeps this module runtime-value-free so it
// never lands in the self-contained CJS preload bundle, V11). The crash-report
// payload is defined renderer-side (its primary consumer) and shared here.
import type { OrchestratorDownReport } from "@lib/orchestrator/client";
import type { ProbeCamera } from "@lib/orchestrator/probe";
export type { OrchestratorDownReport };
export type { ProbeCamera };

export interface FoveaBridge {
  connectOrchestrator(): void;
  /** Live camera list from the enumerate-only PROBE (disposable-orchestrator
   *  ruling 3) — the status-only Welcome window's sole data source. Fires on
   *  every real change (device added/removed/role edit). Returns a disposer. */
  onProbeCameras(cb: (cameras: ProbeCamera[]) => void): () => void;
  /** The orchestrator process went down. The callback receives a typed report
   *  (clean / killed / crash + exit code) so a window can surface a crash
   *  banner (orchestrator-lifecycle-and-exit ruling 3/4); a `clean` report is
   *  delivered too but the surface hides it. */
  onOrchestratorDown(cb: (report: OrchestratorDownReport) => void): void;
  openProfilerWindow(): void;
  /** Open (or switch to) an app window by catalog id (`@lib/windows`) — the
   *  main-process window manager enforces exclusivity + drain
   *  (docs/history/refactor/multi-window.md §3). */
  openAppWindow(appId: string): void;
  /** Open a projection window (single-stream viewer, multi-window.md req. 4)
   *  for one session's frame channel. 0..N instances; passive subscriber —
   *  never activates the source session, never counted for the welcome
   *  rule, survives its source app's close. */
  openProjectionWindow(session: string, frame: string): void;
  /** Toggle a module's `debug`-class sub-window (WS2 2b): open-or-close a
   *  module-owned window for `session`. Owner-bound to the app that requested
   *  it (cascade-closes on app close/switch). `kind` (default `debugger`)
   *  selects which module component the host mounts and lets one session own
   *  both a debugger and a capture-preview window at once
   *  (capture-recorder-nodes.md ruling 8). */
  toggleDebugWindow(session: string, kind?: string): void;
  /** OPEN-OR-FOCUS a module's `debug`-class sub-window (never closes) — the
   *  idempotent sibling of `toggleDebugWindow` for callers that must ENSURE the
   *  window is up (capture-recorder-nodes.md Phase 4: the capture / raster
   *  buttons open the preview window after a shot). */
  openDebugWindow(session: string, kind?: string): void;
  /** Fullscreen transitions for THIS window, forwarded by main from the
   *  BrowserWindow enter/leave-full-screen events — the shared window chrome
   *  adjusts traffic-light inset + drag regions on both edges (A-7). */
  onFullscreenChange(cb: (fullscreen: boolean) => void): void;
  /** Recorder trigger (plain Ctrl/Cmd-R, rebound from reload — multi-window.md
   *  req. 6). Consumed by `RecordButton.vue` (capture-recorder-nodes.md ruling
   *  9): where a recording context exists it toggles start/stop. Returns a
   *  disposer so the consumer can drop the listener on unmount. */
  onRecorderTrigger(cb: () => void): () => void;
  /** Join path segments (replaces `node:path`'s `resolve`, which isn't
   *  reachable from an isolated renderer — the polyfill plugin needs a real
   *  `require`, which only exists under `nodeIntegration: true`). */
  resolvePath(...segments: string[]): Promise<string>;
  /** Preferred default save directory for a capture/recording namespace
   *  (external volume if mounted, else `~/Downloads/<directory>`). */
  resolveDefaultSavePath(directory: string): Promise<string>;
  pathExists(path: string): Promise<boolean>;
  validateWritablePath(path: string): Promise<boolean>;
  /** Writes a perf snapshot JSON blob under `<app data dir>/perf-snapshots/`
   *  and returns the file path written. */
  writePerfSnapshot(content: string): Promise<string>;
  /** Reveals the `<app data dir>/perf-snapshots/` folder in the OS file
   *  browser (creating it if needed) and returns its path. */
  openPerfSnapshotFolder(): Promise<string>;
  /** Reveals ONE written snapshot file (selected in Finder/Explorer). Only
   *  paths inside the perf-snapshots dir are accepted — narrow surface. */
  revealPerfSnapshot(file: string): Promise<void>;
  /** Reveals a recording container in the OS file browser (Finder/Explorer),
   *  selecting the file — the viewer window's "Open folder" affordance
   *  (standalone-viewer-and-fcap UX 5). Any path the renderer holds is accepted
   *  (the bridge already trusts renderer-supplied paths). */
  revealRecording(file: string): Promise<void>;
  /** Pin THIS window above all others (`setAlwaysOnTop`) — the profiler's
   *  nav-bar pin toggle; the renderer persists the choice in localStorage
   *  and re-applies it on mount. */
  setWindowPinned(pinned: boolean): void;
  /** Ask main to fork THIS window's viewer playback engine (a utilityProcess)
   *  over `file` and broker a `MessagePort` back (standalone-viewer-and-fcap,
   *  AS SHIPPED amendment). Renderer-initiated so the port arrives once the
   *  window is loaded and listening; a re-call (dev full-reload) terminates the
   *  previous engine first. The port lands on the DOM `message` event as
   *  `"viewer:port"` (like `orchestrator:port`, outside the typed push table —
   *  a live port can't cross a bridge call). */
  spawnViewerEngine(file: string): void;
  /** The viewer engine process died unexpectedly (crash) — the callback lets
   *  the window surface an error state instead of waiting forever for frames.
   *  Returns a disposer. */
  onViewerEngineDown(cb: (message: string) => void): () => void;
}

// ---- Typed IPC channel registry -------------------------------------------
// The single typed source for every `foveaBridge` IPC channel: name → arg
// tuple → return type. Both sides derive thin wrappers from it (preload-
// bridge.ts's `invoke`/`send`/`listen`; main.ts's `handle`/`onRenderer`/
// `pushTo`), so a channel-name typo or an arg/return-shape mismatch on either
// side is a COMPILE error, not a boot-time surprise (the V11 preload work
// showed how costly a silent bridge break is).
//
// V11: this module is TYPES-ONLY (interfaces, no runtime values). `import
// type` from it erases entirely, so nothing here can land in the self-
// contained CJS preload bundle — no sibling-chunk import, no `import.meta`,
// no `createRequire`. Keep it that way (do not add runtime consts here).

/** Request→response channels (`ipcRenderer.invoke` ↔ `ipcMain.handle`). */
export interface InvokeChannels {
  "save-path:resolve": { args: [segments: string[]]; ret: string };
  "save-path:resolve-default": { args: [directory: string]; ret: string };
  "fs:exists": { args: [path: string]; ret: boolean };
  "fs:validate-writable": { args: [path: string]; ret: boolean };
  "perf-snapshot:write": { args: [content: string]; ret: string };
  "perf-snapshot:open-folder": { args: []; ret: string };
  "perf-snapshot:reveal": { args: [file: string]; ret: void };
  "viewer:reveal": { args: [file: string]; ret: void };
}

/** Fire-and-forget renderer→main signals (`ipcRenderer.send` ↔ `ipcMain.on`).
 *  Value is the arg tuple. */
export interface SendChannels {
  "orchestrator:connect": [];
  "open-profiler-window": [];
  "window:open-app": [appId: string];
  "window:open-projection": [session: string, frame: string];
  "window:toggle-debug": [session: string, kind?: string];
  /** Sender-scoped: main resolves the window from `event.sender`. */
  "window:set-pinned": [pinned: boolean];
  /** Sender-scoped: main forks (or re-forks) this viewer window's playback
   *  engine over `file` and brokers a `MessagePort` back via `viewer:port`. */
  "viewer:spawn": [file: string];
}

/** Main→renderer pushes (`webContents.send` ↔ `ipcRenderer.on`). Value is the
 *  arg tuple. `orchestrator:port` and `viewer:port` are deliberately absent —
 *  they transfer a MessagePort via `postMessage`'s transfer list, outside this
 *  typed table. */
export interface PushChannels {
  "orchestrator:down": [report: OrchestratorDownReport];
  "window:fullscreen": [fullscreen: boolean];
  "recorder:trigger": [];
  /** The viewer engine (utilityProcess) crashed — carries a human message. */
  "viewer:engine-down": [message: string];
  /** Live camera list from the enumerate-only probe (ruling 3). */
  "probe:cameras": [cameras: ProbeCamera[]];
}
