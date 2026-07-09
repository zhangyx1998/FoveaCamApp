// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// capture-recorder-nodes Phase 2 (Wave I-2): the RECORDER NODE. ONE worker
// thread owns the WHOLE write path — it connects the named SHM pipes (raw or
// derived) in FIFO mode (Phase 0 `readSeqInto`), reads them in its own loop,
// and hosts the MCAP writer IN-WORKER. The orchestrator main loop does ZERO
// per-frame frame work (the point of the wave): it only spawns the worker,
// brokers the pipe connect/disconnect, folds worker-posted stats into the graph
// meter on a low-rate timer, and shuttles the ruling-3 per-frame metadata
// callback round-trip.
//
// ONE-WORKER COLLAPSE (report): the pre-wave path had TWO thread hops — the
// consume/copy/transfer ran on the orchestrator main JS loop (recording.ts's
// three `lease.camera.stream` taps) and `McapWriterWorker` (writer.ts) spawned
// its OWN worker just for the encode. This node collapses both into a single
// worker: the FIFO consume loop and the mcap encode/write live in the SAME
// thread, so a captured frame is copied exactly ONCE (reused SHM read buffer →
// a fresh ArrayBuffer handed to the writer chain) and never crosses a
// postMessage boundary. Nothing per-frame touches main.
//
// Container layout/schema contract is UNCHANGED (channels per stream,
// x-fovea-raw encoding, one `telemetry` channel correlated by stream+seq,
// `fovea:session`/`fovea:finalize` metadata) — see recorder/schema.ts +
// recorder/metadata.ts, preserved exactly.
//
// The pure parts (the FIFO consumer state machine, stats folding, the
// ruling-3 extras dispatch) are exported and unit-tested with fakes — the
// worker/native boundary is INJECTED so vitest never loads native core.

import { Worker, type TransferListItem } from "node:worker_threads";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { registerWorkload, type WorkloadHandle } from "./metering.js";
import { registerGraphWiring, type GraphWiring } from "./graph-topology.js";
import { readerAddonPath } from "./vision-worker-host.js";
import { report } from "./diagnostics.js";
import { FreqMeter } from "@lib/util/rolling";
import { significantBits } from "@lib/util/dtype";
import type { StreamType, ContainerDtype } from "@lib/orchestrator/graph-contract.js";
import type { StreamStats, FinalizeStats } from "./recorder/types.js";
import {
  FOVEA_EXTENSION,
  FOVEA_PROFILE,
  FOVEA_LIBRARY,
  SESSION_METADATA_NAME,
  FINALIZE_METADATA_NAME,
  RAW_FRAME_SCHEMA_NAME,
  RAW_FRAME_SCHEMA_DATA,
  RAW_FRAME_MESSAGE_ENCODING,
  TELEMETRY_TOPIC,
  TELEMETRY_SCHEMA_NAME,
  TELEMETRY_SCHEMA_DATA,
  TELEMETRY_MESSAGE_ENCODING,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_QUEUED_FRAMES,
} from "./recorder/schema.js";

const requireFromHere = createRequire(import.meta.url);

// ============================================================================
// PURE PART 1 — the FIFO consumer state machine (Phase 0 read semantics).
// ============================================================================

/** The `readSeqInto` classification (core/test/29-raw-pipe.ts is canonical):
 *  a frame (`seq`), NotYet (not published — retry), Gone (slot recycled —
 *  jump + drop-account), Closed (pipe retired — drain done), or `null`
 *  (torn seqlock read — retry the same seq). */
export type SeqRead =
  | null
  | { closed: true }
  | { notYet: true }
  | { gone: true; oldestSeq: bigint }
  | {
      seq: bigint;
      width: number;
      height: number;
      /** The addon's `okResult` marshals the frame's capture-time metadata
       *  (BigInt ns, present only when the source stamps it — hardware devices
       *  do, the fake camera does not). `deviceTimestamp` is the TRUSTED device
       *  time future FIN pairing correlates on; absent → the consumer falls
       *  back to its own monotonic clock (documented in `onFrame`). */
      meta?: { deviceTimestamp?: bigint; systemTimestamp?: bigint };
    };

/** Everything the FIFO consumer touches — all injected, so the state machine
 *  is exercised in vitest with a fake reader and never loads native core. */
export interface StreamConsumerCfg {
  /** FIFO read of `wantSeq` (the reader copies its bytes into `dst`). */
  read(wantSeq: bigint): SeqRead;
  /** Reused per-stream read buffer (SHM-consumer-reuse-buffer: never alloc per
   *  frame on the read side; the writer copy below is the one owned buffer). */
  dst: Uint8Array;
  /** Active-frame byte length for the writer copy (W·H·channels·bytesPerElem). */
  bytesFor(width: number, height: number): number;
  /** One in-order frame. `view` is `dst` sliced to the active bytes — CONSUME
   *  IT SYNCHRONOUSLY (copy out); `dst` is overwritten by the next read.
   *  `deviceTs` is the frame's TRUSTED capture time (ns) when the source stamps
   *  it (from the addon's `meta.deviceTimestamp`), else `undefined` — the worker
   *  substitutes its monotonic clock. */
  onFrame(
    view: Uint8Array,
    seq: bigint,
    width: number,
    height: number,
    deviceTs: bigint | undefined,
  ): void;
  /** Account `n` ring-recycled frames (consumer lagged a full ring). */
  onDrop(n: number): void;
  /** Short backoff on NotYet (a caught-up, still-open pipe). */
  delay(): Promise<void>;
  /** Backpressure/yield after each written frame — awaited so the in-worker
   *  writer chain advances (and blocks the consumer while its channel window is
   *  full, surfacing overflow as ring `Gone` drops, never an unbounded queue).
   *  Optional (tests omit it). */
  afterWrite?(): Promise<void> | void;
  /** Non-null once finalize was requested: drain up to this seq (inclusive),
   *  then stop. Snapshotting the producer's latest at finalize gives the R-1
   *  "drain to latestSeq then stop" semantics without racing the pipe close. */
  drainTarget(): bigint | null;
  /** First seq to request (the producer's latest at connect, or 1). */
  startSeq: bigint;
}

/**
 * Consume ONE pipe in FIFO order until the pipe closes or the finalize drain
 * completes. The state machine (ruled loss contract, Phase 0):
 *  - `null` (torn read)  → retry the SAME seq
 *  - Closed              → stop (the pipe was retired; R-1: Ok drains first,
 *                          Closed only once `want` passes the last written seq)
 *  - NotYet              → if draining, we've caught up → stop; else back off
 *  - Gone                → account `oldest − want` drops, JUMP to `oldest`
 *  - Ok                  → hand the frame downstream, `want = seq + 1`
 * Pure over `cfg`; drives production and the unit tests identically (the worker
 * embeds this exact function via `.toString()` — see WORKER_SOURCE).
 */
export async function runStreamConsumer(cfg: StreamConsumerCfg): Promise<void> {
  let want = cfg.startSeq;
  for (;;) {
    const target = cfg.drainTarget();
    if (target !== null && want > target) return; // drained to the finalize snapshot
    const r = cfg.read(want);
    if (r === null) continue; // torn seqlock read — retry the same seq
    if ("closed" in r) return; // pipe retired — Ok already drained the tail
    if ("notYet" in r) {
      if (target !== null) return; // draining + caught up to latest → done
      await cfg.delay();
      continue;
    }
    if ("gone" in r) {
      cfg.onDrop(Number(r.oldestSeq - want)); // recycled gap — accounted, never silent
      want = r.oldestSeq; // jump forward to the oldest still-live seq
      continue;
    }
    cfg.onFrame(
      cfg.dst.subarray(0, cfg.bytesFor(r.width, r.height)),
      r.seq,
      r.width,
      r.height,
      r.meta?.deviceTimestamp,
    );
    want = r.seq + 1n;
    if (cfg.afterWrite) await cfg.afterWrite();
  }
}

// ============================================================================
// PURE PART 2 — worker→meter stats folding (low-rate, never per frame).
// ============================================================================

/** Cumulative per-stream counters the worker posts (monotonic totals). */
export interface StreamCounters {
  /** Frames read off the pipe in order (ingested by the consume loop). */
  ingested: number;
  /** Ring-recycled frames the consumer skipped (accounted, not silent). */
  dropped: number;
  /** Frames the mcap writer encoded + wrote. */
  written: number;
  /** Bytes the mcap writer wrote (frame payloads). */
  bytes: number;
}

/** Per-stream folding state kept on the main side (last-seen totals + fps). */
export interface StreamFold {
  prev: StreamCounters;
  fps: FreqMeter;
}

/** The recording-telemetry row shape the UI expects (unchanged). */
export type RecorderStreamStats = StreamStats;

/** Fold the worker's cumulative counters into the graph meter (as DELTAS) and
 *  the per-stream UI stats. Pure over the injected meter + fold state; the host
 *  drives it on the low-rate stats message, so no per-frame meter traffic. */
export function foldStreamStats(
  meter: Pick<WorkloadHandle, "ingest" | "emit" | "drop">,
  folds: Map<string, StreamFold>,
  incoming: Record<string, StreamCounters>,
): Record<string, RecorderStreamStats> {
  const out: Record<string, RecorderStreamStats> = {};
  for (const [name, next] of Object.entries(incoming)) {
    let fold = folds.get(name);
    if (!fold) {
      fold = { prev: { ingested: 0, dropped: 0, written: 0, bytes: 0 }, fps: new FreqMeter() };
      folds.set(name, fold);
    }
    const { prev } = fold;
    const dIngest = Math.max(0, next.ingested - prev.ingested);
    const dDrop = Math.max(0, next.dropped - prev.dropped);
    const dWritten = Math.max(0, next.written - prev.written);
    const dBytes = Math.max(0, next.bytes - prev.bytes);
    if (dIngest) meter.ingest(name, dIngest);
    if (dDrop) meter.drop("ring-recycled", dDrop);
    if (dWritten) meter.emit("written", dWritten);
    if (dBytes) meter.emit("bytes", dBytes);
    for (let i = 0; i < dWritten; i++) fold.fps.tick();
    fold.prev = next;
    out[name] = { frames: next.written, dropped: next.dropped, bytes: next.bytes, fps: fold.fps.value };
  }
  return out;
}

// ============================================================================
// PURE PART 3 — ruling-3 per-frame metadata dispatch (extras correlation).
// ============================================================================

/** The session's ruling-3 handler: given a NEW frame's stream + seq + TRUSTED
 *  capture time (`tNs`, ns — device time when the source stamps it, else the
 *  worker's monotonic clock), return per-frame extras to ride the telemetry
 *  channel, or null. This `tNs` is the value future FIN pairing correlates on.
 *  NEVER blocks the frame write (main invokes it AFTER the frame message is
 *  already queued in the worker). */
export type OnRecordedFrame = (
  stream: string,
  seq: number,
  tNs: bigint,
) => Record<string, unknown> | null | undefined;

/** A worker→main "new frame" notification. Two clocks travel together:
 *  - `logTimeNs` — the container time AXIS the frame was written at (the
 *    worker's monotonic clock, shared across every channel; the telemetry doc
 *    MUST reuse it as its message `logTime` so the viewer's relative-time seek
 *    domain stays single-clock and 0-based — see viewer/source.ts).
 *  - `tNs` — the frame's TRUSTED capture time (device time when stamped, else
 *    equal to `logTimeNs`); the FIN-correlation value carried in the telemetry
 *    doc's `t` field. */
export interface FrameNotice {
  stream: string;
  seq: number;
  logTimeNs: bigint;
  tNs: bigint;
}

/** The main→worker extras message (telemetry doc correlated by stream+seq).
 *  `logTimeNs` is the OWNING frame's container axis time — the telemetry
 *  message reuses it so telemetry and frames stay co-clocked (the trusted `tNs`
 *  lives in the doc `payload`, not on the message logTime). */
export interface ExtrasMessage {
  type: "extras";
  stream: string;
  seq: number;
  logTimeNs: bigint;
  payload: string;
}

/**
 * Invoke the ruling-3 callback for one frame and, if it returns extras, build
 * the telemetry doc (`{stream, seq, t, ...extras}`, `t` = the TRUSTED capture
 * time in SECONDS — the exact pre-wave `telemetry` channel shape) and post it
 * back to the worker with the OWNING frame's `logTimeNs` (so the telemetry
 * message logs on the same container axis as its frame). Returns the message
 * posted (or null when there are no extras / no callback). Pure over the
 * injected callback + post fn — a late/absent reply just means the frame
 * carries no extras, never a stall.
 */
export function dispatchFrame(
  onFrame: OnRecordedFrame | undefined,
  post: (m: ExtrasMessage) => void,
  notice: FrameNotice,
): ExtrasMessage | null {
  const extras = onFrame?.(notice.stream, notice.seq, notice.tNs);
  if (!extras || Object.keys(extras).length === 0) return null;
  const payload = JSON.stringify({
    stream: notice.stream,
    seq: notice.seq,
    t: Number(notice.tNs) / 1e9,
    ...extras,
  });
  const message: ExtrasMessage = {
    type: "extras",
    stream: notice.stream,
    seq: notice.seq,
    logTimeNs: notice.logTimeNs,
    payload,
  };
  post(message);
  return message;
}

// ============================================================================
// The node host (main thread) — spawn/broker/meter/lifecycle only.
// ============================================================================

/** A connected pipe segment the recorder reads: its shm name + decode geometry
 *  (from the broker's `PipeHandle.spec`) + a release (disconnect) disposer. */
export interface RecorderPipeConnection {
  shmName: string;
  spec: {
    pixelFormat: string;
    dtype: string;
    width: number;
    height: number;
    channels: number;
    bytesPerFrame: number;
    /** C-20 slot size (over-provisioned); the read buffer sizes to this. */
    maxBytes?: number;
  };
  /** Disconnect (refcount--) — parks the producer when the last consumer goes. */
  release(): void;
}

/** Injected pipe-connect seam (production: `broker.connect`; tests: a fake). */
export type RecorderConnect = (pipeId: string) => RecorderPipeConnection;

export interface RecorderNodeOptions {
  /** Graph node id — `recorder/<session>` (composed in the session wrapper; no
   *  `nodeId.recorder` helper exists, graph-contract is planner-owned). */
  id: string;
  /** Recording directory; the container is `<path>/recording.fovea`. */
  path: string;
  /** name → pipe. Names are the container channel names. */
  streams: Record<string, { pipeId: string }>;
  /** Connect each named pipe (refcount++ → C-21 gate → producer runs). */
  connect: RecorderConnect;
  /** ISO session timestamp → the `fovea:session` metadata record. */
  timestamp: string;
  /** Ruling-3 per-frame extras callback (optional). */
  onFrame?: OnRecordedFrame;
  /** Test seam: spawn the worker (default: the eval'd WORKER_SOURCE). */
  spawn?: (streams: WorkerStreamInit[]) => WorkerLike;
  /** Test seam: reader-addon path (default: parent-resolved). */
  readerPath?: string;
  /** mcap chunk threshold (default DEFAULT_CHUNK_BYTES). */
  chunkBytes?: number;
  /** Per-channel in-flight window before backpressure (default 8). */
  maxQueuedFrames?: number;
}

export interface RecorderNodeHandle {
  readonly id: string;
  /** Absolute path of the finished container (`recording:finished` payload). */
  readonly filePath: string;
  /** Current per-stream UI stats (mirror into `recordingStreams`). */
  stats(): Record<string, RecorderStreamStats>;
  /** Finalize the container (drain to the producer's latest, write the mcap
   *  summary/index, close the file), terminate the worker, disconnect pipes,
   *  and retire the graph node. Resolves with the finalize stats. */
  stop(): Promise<FinalizeStats>;
}

/** Per-stream init the worker gets in `workerData`. */
export interface WorkerStreamInit {
  name: string;
  shmName: string;
  maxBytes: number;
  channels: number;
  bytesPerElement: number;
  pixelFormat: string;
  dtype: string;
  significantBits: number;
}

/** The `worker_threads.Worker` subset the host drives (injectable for tests). */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: readonly TransferListItem[]): void;
  on(event: "message", cb: (msg: RecorderNodeOut) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  terminate(): Promise<number> | void;
}

/** worker → main protocol. */
export type RecorderNodeOut =
  | { type: "frame"; stream: string; seq: number; logTimeNs: bigint; tNs: bigint }
  | { type: "stats"; streams: Record<string, StreamCounters> }
  | { type: "finalized"; stats: FinalizeStats }
  | { type: "error"; message: string; stack?: string };

const FRAME_STREAM = (pixelFormat: string, dtype: string): StreamType => ({
  kind: "frame",
  pixelFormat,
  // `dtype` came from an advertised pipe spec (a schema Dtype) — trusted narrow.
  dtype: dtype as ContainerDtype,
});

/**
 * Create the recorder node. Connects every named pipe, spawns the one worker,
 * registers the `recorder/<session>` graph row (+ per-stream input edges) and
 * its meter, and wires the ruling-3 callback round-trip. `stop()` finalizes.
 */
export function createRecorderNode(options: RecorderNodeOptions): RecorderNodeHandle {
  const {
    id,
    path,
    streams,
    connect,
    timestamp,
    onFrame,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    maxQueuedFrames = DEFAULT_MAX_QUEUED_FRAMES,
  } = options;

  const filePath = resolve(path, `recording${FOVEA_EXTENSION}`);
  const readerPath = options.readerPath ?? readerAddonPath();

  // --- connect every named pipe (refcount++ → gate → producer runs) ---------
  const connections: RecorderPipeConnection[] = [];
  const workerStreams: WorkerStreamInit[] = [];
  const edges: GraphWiring["edges"] = [];
  const streamNames: string[] = [];
  for (const [name, { pipeId }] of Object.entries(streams)) {
    const conn = connect(pipeId);
    connections.push(conn);
    streamNames.push(name);
    const bytesPerElement = conn.spec.dtype === "U16" ? 2 : 1;
    workerStreams.push({
      name,
      shmName: conn.shmName,
      maxBytes: conn.spec.maxBytes ?? conn.spec.bytesPerFrame,
      channels: conn.spec.channels,
      bytesPerElement,
      pixelFormat: conn.spec.pixelFormat,
      dtype: conn.spec.dtype,
      significantBits: significantBits(conn.spec.pixelFormat as never),
    });
    edges.push({
      from: pipeId,
      to: id,
      port: name,
      type: FRAME_STREAM(conn.spec.pixelFormat, conn.spec.dtype),
      lossy: false, // FIFO deep ring — lossless up to depth, drops accounted
    });
  }

  // --- graph row + meter (per-stream ingest + drops + written/bytes) --------
  const wiring: GraphWiring = {
    nodes: [{ id, kind: "recorder", output: null, transport: "sink" }],
    edges,
  };
  const unregisterWiring = registerGraphWiring(wiring);
  const meter = registerWorkload(id, { inputs: streamNames, outputs: ["written", "bytes"] });

  const folds = new Map<string, StreamFold>();
  let uiStats: Record<string, RecorderStreamStats> = {};

  // --- spawn the one worker -------------------------------------------------
  const worker: WorkerLike = (options.spawn ?? defaultSpawn)(workerStreams);

  const post = (m: RecorderNodeIn, transfer?: TransferListItem[]): void =>
    worker.postMessage(m, transfer);

  let pendingFinalize: {
    resolve: (stats: FinalizeStats) => void;
    reject: (error: Error) => void;
  } | null = null;
  let failed: Error | null = null;

  function fail(error: Error): void {
    if (!failed) failed = error;
    report("recorder-node", error.message);
    pendingFinalize?.reject(error);
    pendingFinalize = null;
  }

  worker.on("message", (msg: RecorderNodeOut) => {
    if (msg.type === "frame") {
      // Ruling-3: invoke the session callback and, if it returns extras, ride
      // them on the telemetry channel. The frame is ALREADY written in-worker;
      // this never blocks it.
      dispatchFrame(onFrame, (m) => post(m), {
        stream: msg.stream,
        seq: msg.seq,
        logTimeNs: msg.logTimeNs,
        tNs: msg.tNs,
      });
    } else if (msg.type === "stats") {
      uiStats = foldStreamStats(meter, folds, msg.streams);
    } else if (msg.type === "finalized") {
      pendingFinalize?.resolve(msg.stats);
      pendingFinalize = null;
    } else {
      fail(Object.assign(new Error(msg.message), { stack: msg.stack }));
    }
  });
  worker.on("error", (err) => fail(err));
  worker.on("exit", (code) => {
    if (pendingFinalize && code !== 0)
      fail(new Error(`recorder worker exited with code ${code}`));
  });

  // Kick the worker off (workerData already carries the streams/config).
  const startedAt = performance.now();
  post({ type: "start", filePath, chunkBytes, maxQueuedFrames, session: { timestamp, app: FOVEA_LIBRARY } });

  let stopped = false;
  return {
    id,
    filePath,
    stats: () => uiStats,
    async stop(): Promise<FinalizeStats> {
      if (stopped) return { messageCount: "0", chunkCount: 0, bytes: 0 };
      stopped = true;
      const durationSec = (performance.now() - startedAt) / 1000;
      const stats = await new Promise<FinalizeStats>((res, rej) => {
        if (failed) return rej(failed);
        pendingFinalize = { resolve: res, reject: rej };
        post({ type: "finalize", durationSec });
      }).catch((e) => {
        report("recorder-node", `finalize failed: ${(e as Error).message}`);
        return { messageCount: "0", chunkCount: 0, bytes: 0 } as FinalizeStats;
      });
      await worker.terminate();
      for (const c of connections) c.release(); // disconnect AFTER the worker's reads
      meter.dispose();
      unregisterWiring();
      return stats;
    },
  };
}

/** main → worker protocol. */
export type RecorderNodeIn =
  | {
      type: "start";
      filePath: string;
      chunkBytes: number;
      maxQueuedFrames: number;
      session: Record<string, string>;
    }
  | { type: "finalize"; durationSec: number }
  | ExtrasMessage;

function defaultSpawn(streams: WorkerStreamInit[]): WorkerLike {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      mcapEntry: requireFromHere.resolve("@mcap/core"),
      readerPath: readerAddonPath(),
      streams,
    },
  }) as unknown as WorkerLike;
}

// ============================================================================
// The worker source (eval'd CJS — the orchestrator bundles to a single file,
// so a sibling worker file would not exist at runtime; same reason
// recorder/worker-source.ts + stream-writer.ts eval theirs, and why the
// `@mcap/core` / reader-addon entry paths are resolved by the PARENT and handed
// in `workerData`). The FIFO consumer is the SAME `runStreamConsumer` exported
// above — embedded verbatim via `.toString()`, so the unit-tested state machine
// and the production loop can never drift.
// ============================================================================

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { open } = require("node:fs/promises");
const { McapWriter } = require(workerData.mcapEntry);
const reader = require(workerData.readerPath);

const FOVEA_PROFILE = ${JSON.stringify(FOVEA_PROFILE)};
const SESSION_METADATA_NAME = ${JSON.stringify(SESSION_METADATA_NAME)};
const FINALIZE_METADATA_NAME = ${JSON.stringify(FINALIZE_METADATA_NAME)};
const RAW_FRAME_SCHEMA_NAME = ${JSON.stringify(RAW_FRAME_SCHEMA_NAME)};
const RAW_FRAME_SCHEMA_DATA = ${JSON.stringify(RAW_FRAME_SCHEMA_DATA)};
const RAW_FRAME_MESSAGE_ENCODING = ${JSON.stringify(RAW_FRAME_MESSAGE_ENCODING)};
const TELEMETRY_TOPIC = ${JSON.stringify(TELEMETRY_TOPIC)};
const TELEMETRY_SCHEMA_NAME = ${JSON.stringify(TELEMETRY_SCHEMA_NAME)};
const TELEMETRY_SCHEMA_DATA = ${JSON.stringify(TELEMETRY_SCHEMA_DATA)};
const TELEMETRY_MESSAGE_ENCODING = ${JSON.stringify(TELEMETRY_MESSAGE_ENCODING)};

// The unit-tested FIFO state machine, embedded verbatim (zero drift).
const runStreamConsumer = (${runStreamConsumer.toString()});

const streams = workerData.streams;
const encoder = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let handle = null;
let writer = null;
let position = 0n;
let finalized = false;
let durationSec = 0;
const channelIds = new Map();
let chain = Promise.resolve();

const writable = {
  position: () => position,
  write: async (buffer) => {
    await handle.write(buffer);
    position += BigInt(buffer.byteLength);
  },
};

function post(message) { parentPort.postMessage(message); }
function report(error) {
  post({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
function enqueue(task) { chain = chain.then(task).catch(report); }

// Per-stream cumulative counters (posted to main on a low-rate timer).
const counters = {};
for (const s of streams) counters[s.name] = { ingested: 0, dropped: 0, written: 0, bytes: 0 };

// Per-stream write seq (mcap sequence — 0-based, matches the pre-wave sink) and
// backpressure: pending in-flight per channel + a resolver the writer completion
// releases, so a full channel window blocks the consumer (→ ring Gone drops).
const writeSeq = {};
const pending = {};
const waiters = {};
const registered = new Set();
for (const s of streams) { writeSeq[s.name] = 0; pending[s.name] = 0; waiters[s.name] = null; }

// Drain snapshot per stream, set on "finalize" (drain to the latest-at-finalize).
const drainTargets = {};
for (const s of streams) drainTargets[s.name] = null;

parentPort.on("message", (m) => {
  if (m.type === "start") {
    enqueueStart(m);
  } else if (m.type === "finalize") {
    durationSec = m.durationSec;
    // Snapshot each producer's latest so the consumers drain the buffered tail
    // and then stop (R-1 semantics without racing the pipe close).
    for (const s of streams) {
      try {
        const latest = reader.latestSeq(s.h);
        drainTargets[s.name] = typeof latest === "bigint" ? latest : BigInt(latest);
      } catch { drainTargets[s.name] = -1n; }
    }
  } else if (m.type === "extras") {
    // Ruling-3: extras are best-effort — a reply that lands after the container
    // finalized degrades to a frame without extras (never a stall / a write on
    // an ended writer). Correlated by stream+seq, so order is immaterial.
    if (finalized) return;
    const channelId = channelIds.get(TELEMETRY_TOPIC);
    if (channelId === undefined) return;
    enqueue(async () => {
      if (finalized) return;
      await writer.addMessage({
        channelId,
        sequence: m.seq,
        logTime: m.logTimeNs,
        publishTime: m.logTimeNs,
        data: encoder.encode(m.payload),
      });
    });
  }
});

function enqueueStart(m) {
  return (async () => {
    handle = await open(m.filePath, "w");
    writer = new McapWriter({ writable, chunkSize: m.chunkBytes });
    await writer.start({ profile: FOVEA_PROFILE, library: m.session.app });
    await writer.addMetadata({
      name: SESSION_METADATA_NAME,
      metadata: new Map(Object.entries(m.session)),
    });
    // The telemetry channel exists on every container (registered up front).
    const telSchema = await writer.registerSchema({
      name: TELEMETRY_SCHEMA_NAME,
      encoding: "jsonschema",
      data: encoder.encode(TELEMETRY_SCHEMA_DATA),
    });
    channelIds.set(
      TELEMETRY_TOPIC,
      await writer.registerChannel({
        schemaId: telSchema,
        topic: TELEMETRY_TOPIC,
        messageEncoding: TELEMETRY_MESSAGE_ENCODING,
        metadata: new Map(),
      }),
    );
    // Open every stream's reader handle + start its consumer.
    for (const s of streams) {
      s.h = reader.open(s.shmName);
      s.dst = new Uint8Array(s.maxBytes);
    }
    runAll(m.maxQueuedFrames);
  })().catch(report);
}

function registerFrameChannel(s, width, height) {
  const shape = s.channels > 1 ? [height, width, s.channels] : [height, width];
  enqueue(async () => {
    const schemaId = await writer.registerSchema({
      name: RAW_FRAME_SCHEMA_NAME,
      encoding: "jsonschema",
      data: encoder.encode(RAW_FRAME_SCHEMA_DATA),
    });
    const channelId = await writer.registerChannel({
      schemaId,
      topic: s.name,
      messageEncoding: RAW_FRAME_MESSAGE_ENCODING,
      metadata: new Map(Object.entries({
        dtype: s.dtype,
        shape: JSON.stringify(shape),
        channels: String(s.channels),
        pixelFormat: s.pixelFormat,
        significantBits: String(s.significantBits),
      })),
    });
    channelIds.set(s.name, channelId);
  });
}

function releaseWaiter(name) {
  const w = waiters[name];
  if (w) { waiters[name] = null; w(); }
}

function makeConsumer(s, maxQueued) {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let startSeq;
  try {
    const latest = reader.latestSeq(s.h);
    const l = typeof latest === "bigint" ? latest : BigInt(latest);
    startSeq = l > 0n ? l : 1n;
  } catch { startSeq = 1n; }
  return runStreamConsumer({
    dst: s.dst,
    startSeq,
    bytesFor: (w, h) => w * h * s.channels * s.bytesPerElement,
    read: (want) => reader.readSeqInto(s.h, s.dst, want),
    delay: () => sleep(2),
    drainTarget: () => drainTargets[s.name],
    onDrop: (n) => { if (n > 0) counters[s.name].dropped += n; },
    onFrame: (view, seq, width, height, deviceTs) => {
      if (!registered.has(s.name)) { registered.add(s.name); registerFrameChannel(s, width, height); }
      counters[s.name].ingested += 1;
      const outSeq = writeSeq[s.name]++;
      // logTimeNs = the container time AXIS (worker monotonic clock, shared by
      // EVERY channel incl. telemetry — keeps the viewer seek domain single-
      // clock/0-based). tNs = the TRUSTED capture time: the frame's device
      // timestamp when the source stamps it (R-2 fix), else the axis clock.
      const logTimeNs = BigInt(Math.round(now() * 1e6));
      const tNs = typeof deviceTs === "bigint" ? deviceTs : logTimeNs;
      // ONE copy: reused SHM read buffer → an owned ArrayBuffer for the chain.
      const data = new ArrayBuffer(view.byteLength);
      new Uint8Array(data).set(view);
      pending[s.name] += 1;
      enqueue(async () => {
        const channelId = channelIds.get(s.name);
        const bytes = new Uint8Array(data);
        await writer.addMessage({
          channelId,
          sequence: outSeq,
          logTime: logTimeNs,
          publishTime: logTimeNs,
          data: bytes,
        });
        counters[s.name].written += 1;
        counters[s.name].bytes += bytes.byteLength;
        pending[s.name] -= 1;
        if (pending[s.name] < maxQueued) releaseWaiter(s.name);
      });
      // Ruling-3: notify main of the NEW frame (extras ride back async). Carry
      // BOTH clocks: the axis time so the telemetry doc co-clocks with its
      // frame, and the trusted capture time for the FIN-correlation 't' field.
      post({ type: "frame", stream: s.name, seq: outSeq, logTimeNs, tNs });
    },
    afterWrite: () => {
      // Yield so the writer chain advances; block while the channel window is
      // full (surfaces as ring Gone drops on resume — never an unbounded queue).
      if (pending[s.name] < maxQueued) return Promise.resolve();
      return new Promise((r) => { waiters[s.name] = r; });
    },
  });
}

function runAll(maxQueued) {
  const statsTimer = setInterval(() => {
    const snapshot = {};
    for (const s of streams) snapshot[s.name] = { ...counters[s.name] };
    post({ type: "stats", streams: snapshot });
  }, 250);
  statsTimer.unref && statsTimer.unref();
  Promise.all(streams.map((s) => makeConsumer(s, maxQueued)))
    .then(() => {
      // No frame reads remain (consumers drained); stop admitting late extras
      // BEFORE flushing so nothing races the non-reentrant writer's end().
      finalized = true;
      return new Promise((r) => { enqueue(async () => r()); }); // flush pending writes
    })
    .then(async () => {
      clearInterval(statsTimer);
      let stats = { messageCount: "0", chunkCount: 0, bytes: Number(position) };
      if (writer) {
        await writer.addMetadata({
          name: FINALIZE_METADATA_NAME,
          metadata: new Map(Object.entries({ durationSec: String(durationSec) })),
        });
        await writer.end();
        const st = writer.statistics;
        for (const s of streams) { try { reader.close(s.h); } catch {} }
        await handle.close();
        stats = { messageCount: String(st ? st.messageCount : 0), chunkCount: st ? st.chunkCount : 0, bytes: Number(position) };
      }
      // Final stats push so the UI shows the last frames.
      const snap = {};
      for (const s of streams) snap[s.name] = { ...counters[s.name] };
      post({ type: "stats", streams: snap });
      post({ type: "finalized", stats });
    })
    .catch(report);
}
`;
