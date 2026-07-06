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
}
