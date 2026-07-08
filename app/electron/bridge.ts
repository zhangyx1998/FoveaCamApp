// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The renderer's entire main-process surface once `contextIsolation: true` /
// `nodeIntegration: false` land (docs/refactor/orchestrator.md §7.1 T5 —
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
export interface FoveaBridge {
  connectOrchestrator(): void;
  onOrchestratorDown(cb: () => void): void;
  openProfilerWindow(): void;
  /** Open (or switch to) an app window by catalog id (`@lib/windows`) — the
   *  main-process window manager enforces exclusivity + drain
   *  (docs/refactor/multi-window.md §3). */
  openAppWindow(appId: string): void;
  /** Open a projection window (single-stream viewer, multi-window.md req. 4)
   *  for one session's frame channel. 0..N instances; passive subscriber —
   *  never activates the source session, never counted for the welcome
   *  rule, survives its source app's close. */
  openProjectionWindow(session: string, frame: string): void;
  /** Toggle a module's debug sub-window (WS2 2b): open-or-close its
   *  annotation-overlay window for `session`/`frame`. Owner-bound to the app
   *  that requested it (cascade-closes on app close/switch). */
  toggleDebugWindow(session: string, frame: string): void;
  /** Fullscreen transitions for THIS window, forwarded by main from the
   *  BrowserWindow enter/leave-full-screen events — the shared window chrome
   *  adjusts traffic-light inset + drag regions on both edges (A-7). */
  onFullscreenChange(cb: (fullscreen: boolean) => void): void;
  /** Recorder trigger (plain Ctrl/Cmd-R, rebound from reload — multi-window.md
   *  req. 6). Stub for now; real semantics land with the recorder stage. */
  onRecorderTrigger(cb: () => void): void;
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
}

/** Fire-and-forget renderer→main signals (`ipcRenderer.send` ↔ `ipcMain.on`).
 *  Value is the arg tuple. */
export interface SendChannels {
  "orchestrator:connect": [];
  "open-profiler-window": [];
  "window:open-app": [appId: string];
  "window:open-projection": [session: string, frame: string];
  "window:toggle-debug": [session: string, frame: string];
}

/** Main→renderer pushes (`webContents.send` ↔ `ipcRenderer.on`). Value is the
 *  arg tuple. `orchestrator:port` is deliberately absent — it transfers a
 *  MessagePort via `postMessage`'s transfer list, outside this typed table. */
export interface PushChannels {
  "orchestrator:down": [];
  "window:fullscreen": [fullscreen: boolean];
  "recorder:trigger": [];
}
