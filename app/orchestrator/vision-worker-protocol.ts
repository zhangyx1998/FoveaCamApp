// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// MessagePort protocol for the per-session vision worker (C-22b, WS1 real-1f).
// The worker is READ-ONLY SHM: main brokers `connectPipe`/`disconnectPipe` (the
// C-21 gate), hands the worker the `shmName`(s), and the worker `reader.open`/
// `readInto`s them, runs core/Vision off the main loop, and posts RESULTS +
// derived DISPLAY frames back. The worker NEVER touches the broker/gate.
//
// Fork-independent (shared by main + worker regardless of worker packaging).
// Numbers only + transferred `ArrayBuffer`s — nothing here imports core or the
// frame transport, so it compiles into both the main bundle and the worker.

export type Role = "L" | "C" | "R";

/** One camera pipe the worker reads (SHM), keyed by role. */
export type PipeInput = {
  role: Role;
  /** POSIX segment name from `connectPipe` — the worker `reader.open`s it. */
  shmName: string;
  width: number;
  height: number;
  channels: number;
  bytesPerFrame: number;
};

/** Init: the worker opens its readers and starts its poll loop. `readerPath`
 *  is the parent-resolved shm-reader addon path (bare `require` in a worker
 *  resolves against cwd, not the app dir — see the recorder worker). */
export type VisionInit = {
  kind: "init";
  pipes: PipeInput[];
  readerPath: string;
  /** Session-specific vision params (tuning/zoom/view/target/homographies…). */
  params: Record<string, unknown>;
};

/** Live param update (volts→homography matrices, tuning, zoom, view, target). */
export type VisionParams = { kind: "params"; params: Record<string, unknown> };

/** Terminate the poll loop + close the readers (worker exits). */
export type VisionStop = { kind: "stop" };

export type VisionWorkerIn = VisionInit | VisionParams | VisionStop;

/** One derived display frame the worker produced (e.g. disparity heatmap,
 *  sliced view). `buffer` is TRANSFERRED (neutered on the worker side) — the
 *  worker allocates a fresh buffer per posted frame. Main wraps it into a Mat
 *  for `session.frame(name, mat)`. */
export type DerivedFrame = {
  name: string;
  buffer: ArrayBuffer;
  width: number;
  height: number;
  channels: number;
};

/** One vision tick's output: scalar RESULTS (fed to actuation/telemetry on
 *  main) + derived frames (published via `session.frame`). Latest-wins, paced
 *  by the worker's own vision throughput — NOT the camera rate. */
export type VisionResult = {
  kind: "result";
  /** Ring seq of the driving frame (for staleness/dedup on main if needed). */
  seq?: number;
  /** Camera device timestamp of the correlated frame(s). */
  deviceTimestamp?: number;
  /** Session-specific scalar results (verge error, match rects/scores, bbox…). */
  values: Record<string, unknown>;
  frames: DerivedFrame[];
};

/** Non-fatal worker diagnostic (surfaced to `diagnostics.report` on main). */
export type VisionError = { kind: "error"; message: string };

export type VisionWorkerOut = VisionResult | VisionError;
