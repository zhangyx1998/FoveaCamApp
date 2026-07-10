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
import type { WorkloadSnapshot } from "./stats.js";

/** What a stream carries — the typing harness's runtime tags. Frame streams
 *  are fully typed (format + container dtype); non-frame streams are tagged by
 *  kind, `analysis` refined by a named schema (registered in the composition
 *  harness, e.g. "vergence", "checker-corners"). */
/** A frame stream's container dtype: the sensor schema's decoded dtypes plus
 *  "F32" for DERIVED float pipes (the stereo brick's disparity map —
 *  stereo-disparity-and-heatmap-nodes). Not a sensor format: no
 *  PIXEL_FORMATS row, no renderer decode path. */
export type ContainerDtype = Dtype | "F32";

export type StreamType =
  | { kind: "frame"; pixelFormat: string; dtype: ContainerDtype }
  | { kind: "track" } // KCF TrackResult stream
  | { kind: "detect" } // marker detection sets
  | { kind: "analysis"; schema: string }; // named scalar-record stream

/** How a node's output physically moves (display concern only — the graph is
 *  transport-agnostic; non-pipe streams are first-class nodes). */
export type StreamTransport =
  | "native" // C++ thread → C++ thread, in-process
  | "pipe" // SHM seqlock ring (readable cross-process)
  | "worker" // JS worker_thread compute node (vision kernels)
  | "port" // worker_thread MessagePort
  | "channel" // orchestrator↔renderer session channel (frames/telemetry)
  | "sink"; // consumes only (renderer view, recorder file)

/** The transport vocabulary of the universal reporting shape (unified-time-and-
 *  topology §6) — a subset of `StreamTransport` ("channel" streams are not
 *  self-reporting nodes; they surface as sinks). */
export type NodeTransport = "pipe" | "native" | "worker" | "port" | "sink";

/** UNIVERSAL node self-report (unified-time-and-topology §6) — ONE shape for
 *  every node type: native bricks (`Topology.report()` NAPI, P3), JS workers
 *  (the meterName machinery generalizes to this), session compositions.
 *  This is the REPORTING shape; `GraphTopology` (nodes+edges) stays the SERVED
 *  shape — `buildTopologyFromReports` derives edges MECHANICALLY from `inputs`
 *  (each input = one edge INTO this node; wiring is owned by the consumer). */
export type NodeReport = {
  /** Path-like unique id (built via `nodeId`). */
  id: string;
  /** Brick kind: convert | undistort | fovea | kcf | kernel names | … */
  kind: string;
  transport: NodeTransport;
  /** ACTUAL live input connections — the graph's only edge source. `lossy`
   *  marks latest-wins subscriptions (SHM seqlock reads, Leaky channels) so
   *  the derived edge reports a drop rate; FIFO/lossless links omit it. */
  inputs: { from: string; port: string; type: StreamType; lossy?: boolean }[];
  output: StreamType | null;
  /** Full meter snapshot (one schema, already converged). Absent = the
   *  topology builder folds stats BY ID from the perfSnapshot workloads map. */
  stats?: WorkloadSnapshot;
  /** Composing owner (`win/<windowId>`) — ABSENT for shared resource bricks. */
  owner?: string;
  /** Reuse-safe identity generation (C-20). */
  epoch?: number;
  /** Pipe-transport extras: the live consumer refcount (aggregate consumer
   *  sinks render until the compose protocol brings consumer identity) and the
   *  EXACT `bytesTotal` accumulator (diffed across snapshots for MB/s). Only
   *  meaningful when `transport === "pipe"`. */
  pipe?: { consumers: number; bytesTotal: number };
};

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
  /** Pipe-transport extras mirrored from `NodeReport.pipe` — the live SHM
   *  consumer refcount is the POSITIVE "no downstream demand" signal the
   *  profiler uses to mark a parked pipe idle (a 0-consumer pipe emits no
   *  consumer edge, so the node must carry the count). Only meaningful when
   *  `transport === "pipe"`. */
  pipe?: { consumers: number; bytesTotal: number };
};

/** One direction of an edge's measured flow. Raw numbers in JSON (snapshot
 *  exports stay machine-readable); the profiler humanizes for display
 *  (`humanHz`/`humanBytesPerSec` in stats.ts). Absent field = unmetered. */
export type EdgeFlow = {
  /** Event frequency (frames/results per second). */
  hz?: number;
  /** Payload throughput. */
  bytesPerSec?: number;
  /** Worst gap between consecutive events over the meter's capture window
   *  (C-18 semantics; the profiler's report rate — default 1 Hz — is
   *  configurable and bounds how often this is sampled, not the window). */
  maxIntervalMs?: number;
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
  /** TX: what the PRODUCER put on the wire (its output meter + pipe byte
   *  accumulator). */
  tx?: EdgeFlow;
  /** RX: what the CONSUMER actually took (its per-port input meter). On a
   *  lossless link rx ≈ tx; on a lossy one the gap is the drop rate. */
  rx?: EdgeFlow;
  /** Drop rate (events/sec) — ONLY meaningful on lossy transports (SHM
   *  seqlock pipes, Leaky latest-wins channels); absent on lossless FIFO
   *  links. Sourced from the consumer's skip counter when metered, else
   *  max(0, tx.hz − rx.hz). */
  dropPerSec?: number;
  /** True when this link's transport is lossy (latest-wins semantics) —
   *  the display shows drop info only for these. */
  lossy?: boolean;
  /** FIFO (lossless) links: consumer-side queue stats — `highWater` = max
   *  queued depth over the trailing 10s window. Shown IN PLACE OF the drop
   *  rate (controller-node-and-fifo-edges §2); mutually exclusive with
   *  `dropPerSec` in practice. */
  queue?: { highWater: number; capacity: number; depth?: number };
  /** @deprecated legacy single-direction fields — mirrors `tx` during the
   *  migration; readers move to tx/rx. */
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
  /** DISPLAY-ONLY serial→role map ("L"/"C"/"R") published by the session that
   *  leases the camera triple, so the profiler labels leased cameras by role
   *  instead of serial in an application context. ABSENT (→ serial labels) for
   *  manage-cameras, where the serial IS the identity. Never keyed onto node
   *  ids — labeling is a pure view concern (`nodeLabel`). */
  roles?: Record<string, string>;
};

/** THE single source of node-id spelling (C-24 step 1: the former
 *  `camera:<serial>` / `undistort:<serial>` pipe ids are now these paths).
 *  Renderer and orchestrator both build ids through here — never inline the
 *  strings. Pure, dependency-free (renderer-safe). */
export const nodeId = {
  /** Raw camera source (native Arv stream — not an SHM pipe). */
  camera: (serial: string): string => `camera/${serial}`,
  /** RGBA8 converted preview pipe (formerly `camera:<serial>`). */
  convert: (serial: string): string => `camera/${serial}/convert`,
  /** Undistorted stream pipe (formerly `undistort:<serial>`). */
  undistort: (serial: string): string => `camera/${serial}/undistort`,
  /** Native KCF tracker stream (track results; non-pipe transport). */
  kcf: (serial: string): string => `camera/${serial}/kcf`,
  /** Native MULTI-target KCF stream (B-25: one thread, batched per-frame
   *  targets). One STABLE id regardless of cal mode — fused undistort is a
   *  brick PARAM, not identity. */
  kcfMulti: (serial: string): string => `camera/${serial}/kcf-multi`,
  /** CHAINED KCF tracker on the camera's undistort brick (controller-node-
   *  and-fifo-edges §3.5): tracks the undistorted view on its own native
   *  thread — the id nests under /undistort/ because that IS its input. */
  undistortKcf: (serial: string): string => `camera/${serial}/undistort/kcf`,
  /** Marker detector stream (non-pipe transport). */
  detect: (serial: string): string => `camera/${serial}/detect`,
  /** Dynamic fovea crop pipe (B-24 brick; slot reuse is epoch-guarded). The id
   *  nests under /undistort/ (it IS a crop of the undistorted space); since the
   *  §5 re-chain the PHYSICAL dataflow matches — the brick chains on the
   *  camera's shared undistort (or convert, uncalibrated fallback) brick, and
   *  chained bricks self-report that edge via Topology.report(). The legacy
   *  pipe-row derivation still renders camera→fovea for unreported rows. */
  fovea: (serial: string, slot: number): string =>
    `camera/${serial}/undistort/fovea/${slot}`,
  /** SESSION-owned slice node (split-disparity-nodes): a named reuse of the
   *  fovea crop brick, nested under /undistort/ like `fovea` (it IS a crop of
   *  the undistorted space) but keyed by NAME, not slot — session-owned crops
   *  never churn through the renderer compose protocol, so they live outside
   *  the numbered slot space. */
  slice: (serial: string, name: string): string =>
    `camera/${serial}/undistort/slice/${name}`,
  /** SCALE/RESIZE node (split-disparity-nodes ruling 5): nests under its
   *  SOURCE pipe id — that IS its input, same rule as fovea/kcf. */
  scale: (sourceId: string, name: string): string =>
    `${sourceId}/scale/${name}`,
  /** STEREO disparity node (stereo-disparity-and-heatmap-nodes): a two-input
   *  join brick (SGBM, F32 disparity out). A NEW root — a cross-camera join
   *  honestly belongs to neither camera; its left/right edges carry the
   *  wiring (self-reported via Topology.report()). */
  stereo: (name: string): string => `stereo/${name}`,
  /** HEATMAP colormap node (F32/U8 1-channel → RGBA8): nests under its
   *  SOURCE pipe id — that IS its input, same rule as scale. */
  heatmap: (sourceId: string, name: string): string =>
    `${sourceId}/heatmap/${name}`,
  /** The MEMS controller node (controller-node-and-fifo-edges §3): a SINGLETON
   *  logical id — the serial port is a stat, not identity, so PID-node edges
   *  registered before the device connects stay stable. */
  controller: (): string => "controller",
  /** Window-composed node (kernels, private compositions). */
  win: (windowId: string, ...segments: string[]): string =>
    ["win", windowId, ...segments].join("/"),
} as const;
