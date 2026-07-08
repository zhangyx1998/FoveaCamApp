// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Main-side spawner for the per-session vision worker (C-22b, WS1 real-1f). A
// vision session, on acquire, `connectPipe`s its camera pipes (bumping the C-21
// gate so the converter runs), then `createVisionWorker(...)` spawns the
// bundled worker (`.dist/electron/vision-worker.js`, an A-owned vite entry),
// hands it the `shmName`s + reader-addon path, and pumps params/results over a
// MessagePort. On release, `terminate()` (tied to the session's ResourceScope).
//
// The worker is READ-ONLY SHM: this host owns the broker/gate (connect/
// disconnect) and passes only shmNames — the worker never touches the broker.
// Orchestrator-side, Vue-free.

import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { report } from "./diagnostics.js";
import type {
  VisionInit,
  VisionResult,
  VisionWorkerIn,
  VisionWorkerOut,
} from "./vision-worker-protocol.js";

const requireHere = createRequire(import.meta.url);

/** Resolve the shm-reader addon path the parent hands the worker (bare
 *  `require` in a worker resolves against cwd, not the app dir — same reason
 *  the recorder worker gets its `@mcap/core` path from the parent). */
function readerAddonPath(): string {
  const coreEntry = requireHere.resolve("core");
  const dir = coreEntry.slice(0, coreEntry.lastIndexOf("/"));
  const runtime = process.versions.electron ? "electron" : "node";
  const version = process.versions[runtime as "electron" | "node"]!;
  return `${dir}/.bin/${runtime}-${version}-${process.arch}-shm-reader.node`;
}

/** The bundled worker entry, next to this orchestrator bundle in
 *  `.dist/electron/`. If path resolution needs a build tweak it's an A-28
 *  (vite.config) concern — flagged, not patched here. */
const WORKER_URL = new URL("./vision-worker.js", import.meta.url);

export interface VisionWorkerHandle {
  /** Push a live param update (homography matrices, tuning, zoom, view, …). */
  sendParams(params: Record<string, unknown>): void;
  /** Terminate the worker (idempotent). */
  terminate(): void;
}

/** The subset of `worker_threads.Worker` the host drives — injectable so the
 *  message routing is unit-testable without spawning the (build-gated) real
 *  worker file. */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: readonly unknown[]): void;
  on(event: "message", cb: (msg: VisionWorkerOut) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  terminate(): Promise<number> | void;
}

/** Test seams for `createVisionWorker` (both default to production). */
export interface VisionWorkerOpts {
  /** Spawn the worker (default: the bundled `.dist/electron/vision-worker.js`). */
  spawn?: () => WorkerLike;
  /** Override the reader-addon path (default: parent-resolved via createRequire —
   *  unresolvable under vitest, so tests inject it). */
  readerPath?: string;
}

/**
 * Spawn the vision worker for a session. `init` carries the pipe `shmName`s +
 * initial params; `onResult` receives each vision tick (scalar `values` +
 * transferred derived `frames`). Errors are routed to `diagnostics.report`.
 */
export function createVisionWorker(
  init: Omit<VisionInit, "kind" | "readerPath">,
  onResult: (r: VisionResult) => void,
  opts: VisionWorkerOpts = {},
): VisionWorkerHandle {
  const worker = (opts.spawn ?? (() => new Worker(WORKER_URL) as unknown as WorkerLike))();
  const readerPath = opts.readerPath ?? readerAddonPath();
  let alive = true;

  worker.on("message", (msg: VisionWorkerOut) => {
    if (msg.kind === "result") onResult(msg);
    else if (msg.kind === "error") report("vision-worker", msg.message);
  });
  worker.on("error", (err) => report("vision-worker", err.message));
  worker.on("exit", () => {
    alive = false;
  });

  const post = (msg: VisionWorkerIn) => {
    if (alive) worker.postMessage(msg);
  };

  post({ kind: "init", readerPath, ...init });

  return {
    sendParams(params) {
      post({ kind: "params", params });
    },
    terminate() {
      if (!alive) return;
      post({ kind: "stop" }); // post BEFORE clearing `alive` (post is gated on it)
      alive = false;
      void worker.terminate();
    },
  };
}
