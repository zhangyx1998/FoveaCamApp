// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// real-2 GRAPH TOPOLOGY CONTRACT (C-24, DRAFT pending planner ruling — shape
// published EARLY for A-33's profiler graph panel; types only, zero runtime).
//
// The orchestrator's stream node graph: every producing endpoint (camera
// source, converter, undistort, KCF, detector, fovea crop, vision kernels) and
// every consuming endpoint (renderer views, worker inputs, recorder) is a NODE
// with a unique PATH-LIKE id (= its output stream id); connections are EDGES
// carrying the stream's type + measured flow. Stats fold from the existing
// meters (native ThreadMeter probes, pipe meters, JS WorkloadSnapshot) — same
// numbers the profiler tables already show, keyed onto the graph.
//
// Id scheme (C-24 §1): `/`-separated paths, two roots —
//   camera/<serial>[/...]   shared resource bricks, broker-owned, refcounted
//                           (e.g. camera/123, camera/123/convert,
//                            camera/123/undistort, camera/123/kcf,
//                            camera/123/undistort/fovea/2)
//   win/<windowId>/[...]    window-composed nodes (renderer-demanded, lifetime
//                           = the composition; e.g. win/tracking-1/display)
// A format ACCESS MODIFIER stays in the last segment as `@<PixelFormat>` only
// when a SECOND simultaneous format of the same stream exists (C-23 ruling
// carried forward); the default format is unsuffixed and lives in the type.

import type { Dtype } from "../../../docs/schema/pixel-formats.js";

/** What a stream carries — the typing harness's runtime tags. Frame streams
 *  are fully typed (format + container dtype); non-frame streams are tagged by
 *  kind, `analysis` refined by a named schema (registered in the composition
 *  harness, e.g. "vergence", "checker-corners"). */
export type StreamType =
  | { kind: "frame"; pixelFormat: string; dtype: Dtype }
  | { kind: "track" } // KCF TrackResult stream
  | { kind: "detect" } // marker detection sets
  | { kind: "analysis"; schema: string }; // named scalar-record stream

/** How a node's output physically moves (display concern only — the graph is
 *  transport-agnostic; non-pipe streams are first-class nodes). */
export type StreamTransport =
  | "native" // C++ thread → C++ thread, in-process
  | "pipe" // SHM seqlock ring (readable cross-process)
  | "port" // worker_thread MessagePort
  | "channel" // orchestrator↔renderer session channel (frames/telemetry)
  | "sink"; // consumes only (renderer view, recorder file)

/** Per-node meter badge — the SAME numbers the profiler's workload table shows
 *  (WorkloadSnapshot / native ThreadMeter probe), reduced to badge form.
 *  Absent field = meter doesn't track it; absent `stats` = unmetered node. */
export type NodeStats = {
  utilization?: number; // 0..1 busy fraction over the window
  ratePerSec?: number; // outputs/sec
  maxIntervalMs?: number; // C-18: worst output gap in the 10s window
  dropsPerSec?: number;
  dropsTotal?: number;
  saturated?: boolean; // existing SATURATED-flag semantics
};

export type GraphNode = {
  /** Path-like unique id = the node's OUTPUT stream id (see header). */
  id: string;
  /** Brick kind: "camera" | "convert" | "undistort" | "kcf" | "detect" |
   *  "fovea" | kernel names ("display" | "disparity" | ...) | consumer kinds
   *  ("view" | "record" | "worker-input"). Open set — style by kind, don't
   *  exhaustively switch. */
  kind: string;
  /** Output stream type; null for pure sinks (views, recorder). */
  output: StreamType | null;
  transport: StreamTransport;
  /** Composing owner (`win/<windowId>`) — ABSENT for shared resource bricks. */
  owner?: string;
  /** Reuse-safe identity generation (C-20): a re-created node with the same id
   *  bumps epoch — treat (id, epoch) as the stable layout key. */
  epoch?: number;
  stats?: NodeStats;
};

/** One wiring: producer node → a NAMED input port of a consumer node. Wiring
 *  lives ONLY here (nodes don't duplicate their input lists). */
export type GraphEdge = {
  from: string; // producer node id
  to: string; // consumer node id
  port: string; // consumer's input port name ("C", "L", "R", "in", ...)
  type: StreamType;
  /** Pipe-backed edges: live consumer refcount on the producer's pipe. */
  consumers?: number;
  /** Measured flow (from the pipe/producer meter), when known. */
  ratePerSec?: number;
  bytesPerSec?: number;
};

export type GraphTopology = {
  /** Monotonic snapshot sequence — for cheap change detection + stable layout
   *  (A: diff nodes by (id, epoch) across seqs; don't re-layout on stats). */
  seq: number;
  /** Snapshot wall time, epoch ms. */
  at: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
};
