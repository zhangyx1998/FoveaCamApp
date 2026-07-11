// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The renderer's entire main-process surface (contextIsolation): each method is
// a thin `ipcRenderer` wrapper exposed as `foveaBridge` in preload. The
// orchestrator `MessagePort` can't cross a bridge call (structured-clone limits)
// — it's handed off separately via `window.postMessage` (preload's
// `orchestrator:port` listener + client.ts `connect()`). Kept narrow on purpose.
// TYPE-ONLY imports below stay erased at build so this module contributes no
// runtime value to the self-contained CJS preload bundle (V11).
import type { OrchestratorDownReport } from "@lib/orchestrator/client";
import type { ProbeCamera } from "@lib/orchestrator/probe";
import type { PatchOp } from "@lib/store-patch";
import type { TeleCanvasMode, TeleCanvasStatus, TeleCanvasTarget } from "@lib/telecanvas";
export type { OrchestratorDownReport };
export type { ProbeCamera };
export type { TeleCanvasMode, TeleCanvasStatus };

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
  /** Open (or focus) the app-wide Settings window (also reachable via the
   *  "Settings…" app-menu item / Cmd+, ). Singleton — a second call focuses the
   *  existing window. */
  openConfigWindow(): void;
  /** Open (or focus) the TeleCanvas window (the title-bar TV icon). Singleton —
   *  a second call focuses the existing window. */
  openTeleCanvasWindow(): void;
  /** Nudge main with the desired push-target config {mode, port, url}: main
   *  reconciles the HOST server (mode/port) AND re-broadcasts the full target to
   *  EVERY window (`onTeleCanvasTarget`). The config-editing windows send this on
   *  change — main owns the host process AND is the single cross-instance
   *  authority (the per-instance store-hub broadcast does not reach an app
   *  window in a different orchestrator instance). Idempotent main-side. */
  applyTeleCanvas(mode: TeleCanvasMode, port: number, url: string): void;
  /** Current TeleCanvas host status (mode / listening / port / reachable URLs /
   *  error) — for a freshly opened window/section to sync before the next push. */
  getTeleCanvasStatus(): Promise<TeleCanvasStatus>;
  /** Subscribe to TeleCanvas host status changes (spawn / listening / crash /
   *  mode switch). Returns a disposer. */
  onTeleCanvasStatus(cb: (status: TeleCanvasStatus) => void): () => void;
  /** Main's current push-target config {mode, url, port} — the authoritative
   *  WHERE-to-PUT an app-window `Pusher` reads at mount (before its first
   *  broadcast), independent of which orchestrator instance the window is on. */
  getTeleCanvasTarget(): Promise<TeleCanvasTarget>;
  /** Subscribe to push-target changes (a settings edit in ANY window, or a host
   *  (re)listen — the latter re-fires so the Pusher re-PUTs and refills a fresh
   *  host's empty buffer after a respawn). Returns a disposer. */
  onTeleCanvasTarget(cb: (target: TeleCanvasTarget) => void): () => void;
  /** Open (or switch to) an app window by catalog id (`@lib/windows`) — the
   *  main-process window manager enforces exclusivity + drain
   *  (docs/history/refactor/multi-window.md §3). */
  openAppWindow(appId: string): void;
  /** Open a projection window (split-pane viewer, projection-split-view.md)
   *  seeded with ONE pane. `pane` is a serialized pane descriptor
   *  (`@lib/projection/descriptor` `serializePane`) — a `{kind:"frame",…}` or
   *  `{kind:"pipe",…}` source. 0..N instances; passive subscriber — never
   *  activates the source session, never counted for the welcome rule, survives
   *  its source app's close. The window then owns its own split layout in-URL. */
  openProjectionWindow(pane: string): void;
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
  /** Preferred default save directory for a capture/recording namespace. When
   *  `base` (the user's configured `default_save_dir`) is given and exists it
   *  wins; otherwise external volume if mounted, else `~/Downloads/<directory>`. */
  resolveDefaultSavePath(directory: string, base?: string): Promise<string>;
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
  /** Reveal a crash-diagnostics file (the flushed stdout/stderr ring log or a
   *  native minidump) in the OS file browser, selecting it — the CrashReport
   *  banner's "Reveal in Finder" affordance. Any path the down report carried
   *  is accepted (the bridge already trusts renderer-supplied paths). */
  revealCrashFile(file: string): Promise<void>;
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
  /** System save dialog for a video export (viewer-export spec 8). `defaultName`
   *  is the suggested basename (`<recording>-<stream>`), `ext` the container
   *  extension (no dot). Resolves to the chosen absolute path, or null when the
   *  user cancels. */
  showExportSaveDialog(defaultName: string, ext: string): Promise<string | null>;
  /** Is a live capture (hardware) app session currently running? The viewer
   *  banner seeds off this (viewer-export addendum). Subscribe to
   *  `onAppSessionActive` BEFORE awaiting this, so a change between seed + await
   *  isn't missed (the telecanvas:target seed+push pattern). */
  getAppSessionActive(): Promise<boolean>;
  /** Live capture session started/stopped — main broadcasts to every window on
   *  change (mirrors `onTeleCanvasTarget`). Returns a disposer. */
  onAppSessionActive(cb: (active: boolean) => void): () => void;
  /** Tell main whether THIS viewer window has queued/running exports — main uses
   *  it to intercept the window CLOSE with an abort confirm (spec 11). Sent on
   *  every 0-crossing of the active-export count. */
  setViewerExportsActive(active: boolean): void;
  /** Main asks THIS window to confirm a close while exports run (spec 11): show
   *  the abort modal. On confirm the renderer aborts its exports then calls
   *  `confirmViewerClose`; on cancel it does nothing (the window stays open).
   *  Returns a disposer. */
  onViewerConfirmClose(cb: () => void): () => void;
  /** The user confirmed aborting exports — proceed with the intercepted close
   *  (spec 11). Main destroys the window. */
  confirmViewerClose(): void;
  // ---- Config store (MAIN authority, config-store-main-authority.md) --------
  /** Read a config document AND subscribe this window to future changes
   *  (`Store.open`): every subsequent edit — this window's, another window's, or
   *  an orchestrator-internal session's — arrives via `onStoreChanged`.
   *  Values cross the wire CODEC-ENCODED (wireEncode/wireDecode strings —
   *  structured clone strips a Mat's attached `shape`; store-codec framing). */
  readStore<T>(path: string[], fallback: string): Promise<T>;
  /** One-shot read WITHOUT subscribing (`Store.read`) — the enumeration
   *  primitive (calibration-data manager reads many docs for metadata).
   *  Wire-encoded like `readStore`. */
  readStoreOnce<T>(path: string[], fallback: string): Promise<T>;
  /** Apply a key-level PATCH (set/delete per top-level key, or a whole replace)
   *  to a config document. Main merges + persists + broadcasts to every OTHER
   *  subscriber, so concurrent writers to different keys both survive. `ops` is
   *  a wire-encoded PatchOp[]. */
  patchStore(path: string[], ops: string): Promise<void>;
  /** Delete a config document (`Store.clear`). */
  clearStore(path: string[]): Promise<void>;
  /** List entry names under a config store directory (`Store.list`). */
  listStore(path: string[]): Promise<string[]>;
  /** Subscribe to config-document changes main broadcasts (path + full value).
   *  One process-wide listener; the `Store` client routes by path. Returns a
   *  disposer. */
  onStoreChanged(cb: (path: string[], value: unknown) => void): () => void;
  /** Move a STORE document to the OS trash (recoverable) instead of a hard
   *  delete — the calibration-records refcount-to-zero rule (never hard-delete;
   *  recoverable from the trash). Main resolves the store path to its backing
   *  file, `shell.trashItem`s it, then clears the doc from the authority cache +
   *  broadcasts. A no-op when the file is already gone. */
  trashStoreDoc(path: string[]): Promise<void>;
  // ---- JSON import/export dialogs + files (calibration records) -------------
  /** System save dialog for a JSON export (calibration record / device-config
   *  bundle). `defaultName` is the suggested basename (no extension). Resolves
   *  to the chosen absolute path (`.json` enforced), or null when cancelled. */
  showJsonSaveDialog(defaultName: string): Promise<string | null>;
  /** System open dialog for a JSON import. Resolves to the chosen absolute path,
   *  or null when cancelled. */
  showJsonOpenDialog(): Promise<string | null>;
  /** Write UTF-8 text to an absolute path (the JSON export sink). */
  writeTextFile(path: string, content: string): Promise<void>;
  /** Read UTF-8 text from an absolute path, or null when absent/unreadable (the
   *  JSON import source). */
  readTextFile(path: string): Promise<string | null>;
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
  "save-path:resolve-default": { args: [directory: string, base?: string]; ret: string };
  "fs:exists": { args: [path: string]; ret: boolean };
  "fs:validate-writable": { args: [path: string]; ret: boolean };
  "perf-snapshot:write": { args: [content: string]; ret: string };
  "perf-snapshot:open-folder": { args: []; ret: string };
  "perf-snapshot:reveal": { args: [file: string]; ret: void };
  "viewer:reveal": { args: [file: string]; ret: void };
  "crash:reveal": { args: [file: string]; ret: void };
  "telecanvas:get-status": { args: []; ret: TeleCanvasStatus };
  "telecanvas:get-target": { args: []; ret: TeleCanvasTarget };
  /** Video-export save dialog (spec 8): [defaultBasename, containerExt] →
   *  chosen absolute path or null (cancelled). */
  "export:save-dialog": { args: [defaultName: string, ext: string]; ret: string | null };
  /** Seed the viewer banner: is a hardware app session live (addendum)? */
  "app-session:active": { args: []; ret: boolean };
  // ---- Config store (MAIN authority) ---------------------------------------
  /** Read a doc + subscribe this window (`Store.open`). Wire-encoded values. */
  "store:read": { args: [path: string[], fallback: string]; ret: string };
  /** One-shot read, no subscribe (`Store.read`). Wire-encoded values. */
  "store:read-once": { args: [path: string[], fallback: string]; ret: string };
  /** Key-level patch merge + broadcast-to-others (`Store.open` writes).
   *  `ops` is a wire-encoded PatchOp[]. */
  "store:patch": { args: [path: string[], ops: string]; ret: string };
  /** Delete a doc (`Store.clear`). */
  "store:clear": { args: [path: string[]]; ret: void };
  /** List entry names under a store directory (`Store.list`). */
  "store:list": { args: [path: string[]]; ret: string[] };
  /** Move a store doc's backing file to the OS trash + clear the cache. */
  "store:trash": { args: [path: string[]]; ret: void };
  // ---- JSON import/export (calibration records) ----------------------------
  /** JSON export save dialog → chosen path (`.json`) or null (cancelled). */
  "dialog:save-json": { args: [defaultName: string]; ret: string | null };
  /** JSON import open dialog → chosen path or null (cancelled). */
  "dialog:open-json": { args: []; ret: string | null };
  /** Write UTF-8 text to an absolute path. */
  "fs:write-text": { args: [path: string, content: string]; ret: void };
  /** Read UTF-8 text from an absolute path (null when absent/unreadable). */
  "fs:read-text": { args: [path: string]; ret: string | null };
}

/** Fire-and-forget renderer→main signals (`ipcRenderer.send` ↔ `ipcMain.on`).
 *  Value is the arg tuple. */
export interface SendChannels {
  "orchestrator:connect": [];
  "open-profiler-window": [];
  "window:open-config": [];
  "window:open-telecanvas": [];
  /** Nudge main with the desired push-target {mode, port, url}: reconcile the
   *  host + re-broadcast the target to every window. */
  "telecanvas:apply": [mode: TeleCanvasMode, port: number, url: string];
  "window:open-app": [appId: string];
  "window:open-projection": [pane: string];
  "window:toggle-debug": [session: string, kind?: string];
  /** Sender-scoped: main resolves the window from `event.sender`. */
  "window:set-pinned": [pinned: boolean];
  /** Sender-scoped: main forks (or re-forks) this viewer window's playback
   *  engine over `file` and brokers a `MessagePort` back via `viewer:port`. */
  "viewer:spawn": [file: string];
  /** Sender-scoped: THIS viewer window's queued/running export count crossed 0
   *  — main uses it to arm/disarm the close-abort intercept (spec 11). */
  "viewer:exports-active": [active: boolean];
  /** Sender-scoped: the user confirmed the export-abort close — proceed with
   *  destroying this window (spec 11). */
  "viewer:close-confirmed": [];
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
  /** TeleCanvas host status changes (standalone dual-mode module). */
  "telecanvas:status": [status: TeleCanvasStatus];
  /** TeleCanvas push-target changes — main → EVERY window (cross-instance). */
  "telecanvas:target": [target: TeleCanvasTarget];
  /** Live capture (hardware) app session started/stopped — main → EVERY window
   *  (viewer banner, addendum). */
  "app-session:active": [active: boolean];
  /** Main → a viewer window: confirm aborting exports before the intercepted
   *  close proceeds (spec 11). */
  "viewer:confirm-close": [];
  /** A config document changed — main → each subscribed window (path + full
   *  value). The `Store` client routes by path and applies in place. */
  "store:changed": [path: string[], value: unknown];
}
