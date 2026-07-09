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
import type { StreamType, ContainerDtype } from "@lib/orchestrator/graph-contract.js";
import type { StreamStats, FinalizeStats } from "./recorder/types.js";
import {
  FOVEA_EXTENSION,
  FOVEA_PROFILE,
  FOVEA_LIBRARY,
  SESSION_METADATA_NAME,
  FINALIZE_METADATA_NAME,
  WIDE_CAMERA_METADATA_NAME,
  RAW_FRAME_SCHEMA_NAME,
  RAW_FRAME_SCHEMA_DATA,
  RAW_FRAME_MESSAGE_ENCODING,
  DESCRIPTOR_SCHEMA_NAME,
  DESCRIPTOR_SCHEMA_DATA,
  DESCRIPTOR_MESSAGE_ENCODING,
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
      /** ACTUAL payload byte length the reader copied into `dst`, when the ring
       *  reports it (core ring v5 `payloadBytes` — a later parallel wave). Absent
       *  on today's ring v4: the consumer falls back to `cfg.bytesFor`. The write
       *  path uses THIS (or the fallback), NEVER a dim-derived count, so
       *  variable-length payloads (compressed codecs) record byte-exact. */
      bytes?: number;
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
   *  frame on the read side; the writer copy below is the one owned buffer).
   *  Sized to the advert's slot (`max(maxBytes, bytesPerFrame)`), so a
   *  variable-length payload up to the slot size fits. */
  dst: Uint8Array;
  /** FALLBACK active-frame byte length, used ONLY when the reader doesn't report
   *  a per-frame `bytes` (ring v4). Advert-driven (the fixed `bytesPerFrame`) —
   *  the recorder is format-agnostic and NEVER computes `w*h*channels*bpe`
   *  (wrong for packed 12p / opaque for compressed). */
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
    // The write length is the reader's ACTUAL payload length when reported
    // (ring v5), else the advert fallback — never dim-derived, so compressed /
    // packed payloads record byte-exact.
    const len = typeof r.bytes === "number" ? r.bytes : cfg.bytesFor(r.width, r.height);
    cfg.onFrame(cfg.dst.subarray(0, len), r.seq, r.width, r.height, r.meta?.deviceTimestamp);
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
    /** OPAQUE advert format string — may carry codec suffixes (e.g.
     *  "BayerRG12p/bz2" from a compression node). Copied VERBATIM into the
     *  channel metadata; the recorder never parses or interprets it. */
    pixelFormat: string;
    dtype: string;
    width: number;
    height: number;
    channels: number;
    /** Fixed per-frame size (advert) — the read buffer + the fallback write
     *  length when the ring reports no per-frame `bytes`. */
    bytesPerFrame: number;
    /** Advert row stride (bytes/row). Copied VERBATIM to metadata; the recorder
     *  never computes it (packed 12p / codec streams own the number). */
    stride?: number;
    /** Advert significant-bit depth. Copied VERBATIM — NOT derived from
     *  `pixelFormat` (a codec-suffixed name would defeat the registry lookup). */
    significantBits?: number;
    /** C-20 slot size (over-provisioned); the read buffer sizes to this. */
    maxBytes?: number;
  };
  /** Disconnect (refcount--) — parks the producer when the last consumer goes. */
  release(): void;
}

/** A multi-fovea target descriptor written to a data (non-frame) channel — the
 *  geometry + raw-frame pointers an offline reconstructor needs (imagery is
 *  never re-encoded; multi-fovea-recording r2 ruling 3). `frames` values are
 *  the per-stream mcap sequences the observation corresponds to. */
export interface FoveaDescriptor {
  /** Observation timestamp (ns). The container axis logTime is stamped by the
   *  worker independently; this is the trusted correlation time in the doc. */
  tNs: number;
  bbox: { x: number; y: number; width: number; height: number };
  frames: { left?: number; center?: number; right?: number };
  /** Room for provenance/extra fields without a schema change. */
  [key: string]: unknown;
}

/** Thrown when `addStream`/`addDataStream`/`postData` race a `stop()` — the
 *  container is finalizing and no new channels/messages can be admitted. */
export class RecorderFinalizedError extends Error {
  readonly code = "RECORDER_FINALIZED";
  constructor(message: string) {
    super(message);
    this.name = "RecorderFinalizedError";
  }
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
  /** Wide camera intrinsics + distortion singleton (multi-fovea-recording r2
   *  ruling 2) → written ONCE at start as the `fovea:wide-camera` metadata
   *  record. Values are JSON-encoded into the MCAP string→string metadata map
   *  by the host (nested arrays/numbers survive). Omit ⇒ no record. */
  cameraMatrix?: Record<string, unknown>;
  /** Ruling-3 per-frame extras callback (optional). */
  onFrame?: OnRecordedFrame;
  /** R-2 opt: the streams `onFrame` can actually return extras for. The worker
   *  posts a per-frame notice (and main invokes `onFrame`) ONLY for these — a
   *  stream absent here (e.g. the center channel, which never carries a fovea
   *  binding) skips the pointless per-frame main-thread round-trip. Omit ⇒ every
   *  stream posts notices (backward-compatible). */
  extrasStreams?: string[];
  /** Test seam: spawn the worker (default: the eval'd WORKER_SOURCE). */
  spawn?: (streams: WorkerStreamInit[]) => WorkerLike;
  /** Test seam: reader-addon path (default: parent-resolved). */
  readerPath?: string;
  /** mcap chunk threshold (default DEFAULT_CHUNK_BYTES). */
  chunkBytes?: number;
  /** Per-channel in-flight window before backpressure (default 8). */
  maxQueuedFrames?: number;
  /** R-2: hard ceiling on `stop()`'s finalize wait (ms, default 30_000). A
   *  wedged in-worker finalize must NEVER hang session teardown / hardware
   *  quiescence: on expiry we log, force-terminate the worker, release the pipes
   *  in order (finalize-before-lease-release is preserved — `stop()` still
   *  returns before the session retires pipes + releases leases), and leave the
   *  truncated container on disk (the documented crash contract). */
  finalizeDeadlineMs?: number;
}

export interface RecorderNodeHandle {
  readonly id: string;
  /** Absolute path of the finished container (`recording:finished` payload). */
  readonly filePath: string;
  /** Current per-stream UI stats (mirror into `recordingStreams`). */
  stats(): Record<string, RecorderStreamStats>;
  /** Connect a frame pipe and start recording it MID-RECORDING (multi-fovea
   *  churn). Legal only before `stop()` — a call racing finalize throws
   *  `RecorderFinalizedError`. Re-using a live name throws. */
  addStream(name: string, opts: { pipeId: string }): void;
  /** Stop recording a frame stream: the worker drains its buffered tail (R-1
   *  drain semantics), the consumer exits, the MCAP channel STAYS registered,
   *  and the pipe is disconnected only after the worker confirms the consumer
   *  exited. No-op for an unknown/already-removed name. */
  removeStream(name: string): void;
  /** Register a data (descriptor) channel MID-RECORDING — one JSON channel per
   *  live target. Legal only before `stop()`. Re-adding a live name is a no-op. */
  addDataStream(name: string): void;
  /** Write one descriptor to a data channel (through the same enqueue chain as
   *  frames, so it never blocks a frame write). Silently dropped if the channel
   *  was never added / was removed / the container is finalizing. */
  postData(name: string, message: FoveaDescriptor): void;
  /** Retire a data channel: the channel STAYS in the container; later
   *  `postData` for it is dropped. No pipe to release (data is pushed). */
  removeDataStream(name: string): void;
  /** Finalize the container (drain every live consumer — including ones added
   *  later — write the mcap summary/index, close the file), terminate the
   *  worker, disconnect pipes, and retire the graph node. Resolves with the
   *  finalize stats. */
  stop(): Promise<FinalizeStats>;
}

/** Per-stream init the worker gets (in `workerData` for initial streams, or an
 *  `add-stream` message for churned ones). */
export interface WorkerStreamInit {
  name: string;
  shmName: string;
  /** Read-buffer size = `max(advert.maxBytes, advert.bytesPerFrame)` (dst
   *  ALLOCATION only — never the write length). */
  maxBytes: number;
  /** Fallback active-frame length (advert `bytesPerFrame`) used only when the
   *  ring reports no per-frame `bytes`. */
  frameBytes: number;
  /** Advert format fields, copied VERBATIM into the channel metadata (ruling
   *  8: the recorder is a format-agnostic socket — no interpretation). */
  width: number;
  height: number;
  channels: number;
  pixelFormat: string;
  dtype: string;
  significantBits: number;
  stride: number;
  /** R-2 opt: post per-frame notices (ruling-3 dispatch) for this stream. */
  wantsExtras: boolean;
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
  /** A frame consumer exited — via `removeStream` drain, finalize drain, OR the
   *  pipe CLOSING (fovea slot destroyed). Main releases that pipe connection. */
  | { type: "stream-ended"; name: string }
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
    extrasStreams,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    maxQueuedFrames = DEFAULT_MAX_QUEUED_FRAMES,
    finalizeDeadlineMs = 30_000,
  } = options;
  // Default (no list): every stream posts notices — backward compatible.
  const wantsExtras = (name: string): boolean =>
    extrasStreams === undefined || extrasStreams.includes(name);

  const filePath = resolve(path, `recording${FOVEA_EXTENSION}`);
  const readerPath = options.readerPath ?? readerAddonPath();

  /** Advert → the worker's per-stream init: format fields copied VERBATIM (the
   *  recorder is a format-agnostic socket — no interpretation), the read buffer
   *  sized to the advert slot, the fallback length = advert `bytesPerFrame`.
   *  Shared by initial + churned streams so nothing can diverge. */
  function buildStreamInit(name: string, conn: RecorderPipeConnection): WorkerStreamInit {
    const { spec } = conn;
    return {
      name,
      shmName: conn.shmName,
      // dst allocation only — bigger of slot size vs nominal frame (a codec slot
      // is over-provisioned above the raw size).
      maxBytes: Math.max(spec.maxBytes ?? 0, spec.bytesPerFrame),
      frameBytes: spec.bytesPerFrame,
      width: spec.width,
      height: spec.height,
      channels: spec.channels,
      pixelFormat: spec.pixelFormat,
      dtype: spec.dtype,
      // Verbatim advert values (never derived from the opaque pixelFormat).
      significantBits: spec.significantBits ?? 0,
      stride: spec.stride ?? (spec.height > 0 ? Math.floor(spec.bytesPerFrame / spec.height) : spec.bytesPerFrame),
      wantsExtras: wantsExtras(name),
    };
  }

  const frameEdge = (pipeId: string, name: string, conn: RecorderPipeConnection) => ({
    from: pipeId,
    to: id,
    port: name,
    type: FRAME_STREAM(conn.spec.pixelFormat, conn.spec.dtype),
    lossy: false, // FIFO deep ring — lossless up to depth, drops accounted
  });

  // --- connect every INITIAL named pipe (refcount++ → gate → producer runs) --
  // `connections` is keyed by stream name so churn (add/remove/pipe-close) can
  // release exactly the right pipe; the graph `edges` array is MUTATED in place
  // (registerGraphWiring holds the object, wiringToReports re-reads it live).
  const connections = new Map<string, RecorderPipeConnection>();
  const workerStreams: WorkerStreamInit[] = [];
  const edges: GraphWiring["edges"] = [];
  const streamNames: string[] = [];
  for (const [name, { pipeId }] of Object.entries(streams)) {
    const conn = connect(pipeId);
    connections.set(name, conn);
    streamNames.push(name);
    workerStreams.push(buildStreamInit(name, conn));
    edges.push(frameEdge(pipeId, name, conn));
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
  // Data (descriptor) channel names admitted so far — the finalize/removed
  // guard for `postData` (the worker also guards, this avoids the round-trip).
  const dataStreams = new Set<string>();
  // Set the instant `stop()` is entered so an in-flight add/post loses the race
  // deterministically (the worker also ignores late add-*; both guard).
  let finalizing = false;

  // --- spawn the one worker -------------------------------------------------
  const worker: WorkerLike = (options.spawn ?? defaultSpawn)(workerStreams);

  const post = (m: RecorderNodeIn, transfer?: TransferListItem[]): void =>
    worker.postMessage(m, transfer);

  /** Release the pipe + drop the graph edge for an ENDED frame stream (worker
   *  confirmed the consumer exited — drain, finalize, or pipe-CLOSED). */
  function releaseStream(name: string): void {
    const conn = connections.get(name);
    if (conn) {
      connections.delete(name);
      conn.release();
    }
    const i = edges.findIndex((e) => e.to === id && e.port === name);
    if (i >= 0) edges.splice(i, 1);
  }

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
    } else if (msg.type === "stream-ended") {
      // A consumer exited (drain / finalize / pipe-CLOSED) — the worker is done
      // reading that pipe, so it's safe to disconnect it now.
      releaseStream(msg.name);
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

  // Kick the worker off (workerData already carries the initial streams).
  const startedAt = performance.now();
  const cameraMatrix = options.cameraMatrix
    ? Object.fromEntries(
        Object.entries(options.cameraMatrix).map(([k, v]) => [
          k,
          typeof v === "string" ? v : JSON.stringify(v),
        ]),
      )
    : undefined;
  post({
    type: "start",
    filePath,
    chunkBytes,
    maxQueuedFrames,
    session: { timestamp, app: FOVEA_LIBRARY },
    ...(cameraMatrix ? { cameraMatrix } : {}),
  });

  let stopped = false;
  return {
    id,
    filePath,
    stats: () => uiStats,
    addStream(name: string, opts: { pipeId: string }): void {
      if (finalizing || stopped)
        throw new RecorderFinalizedError(`addStream("${name}") after finalize`);
      if (connections.has(name))
        throw new RecorderFinalizedError(`stream "${name}" already recording`);
      const conn = connect(opts.pipeId);
      connections.set(name, conn);
      edges.push(frameEdge(opts.pipeId, name, conn));
      post({ type: "add-stream", stream: buildStreamInit(name, conn) });
    },
    removeStream(name: string): void {
      // No main-side release here — the worker drains the tail, then confirms
      // via `stream-ended`, and only THEN do we disconnect the pipe.
      if (!connections.has(name)) return;
      post({ type: "remove-stream", name });
    },
    addDataStream(name: string): void {
      if (finalizing || stopped)
        throw new RecorderFinalizedError(`addDataStream("${name}") after finalize`);
      dataStreams.add(name);
      post({ type: "add-data-stream", name });
    },
    postData(name: string, message: FoveaDescriptor): void {
      if (finalizing || stopped || !dataStreams.has(name)) return;
      post({ type: "data", name, payload: JSON.stringify(message) });
    },
    removeDataStream(name: string): void {
      if (!dataStreams.delete(name)) return;
      post({ type: "remove-data-stream", name });
    },
    async stop(): Promise<FinalizeStats> {
      if (stopped) return { messageCount: "0", chunkCount: 0, bytes: 0 };
      stopped = true;
      finalizing = true;
      const durationSec = (performance.now() - startedAt) / 1000;
      const truncated: FinalizeStats = { messageCount: "0", chunkCount: 0, bytes: 0 };
      // Race the in-worker finalize against a hard deadline so a wedged writer
      // can never hang teardown / hardware quiescence (R-2). On expiry we drop
      // the pending waiter, log, and fall through to terminate + release with
      // the truncated container left on disk (the crash contract).
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const finalizePromise = new Promise<FinalizeStats>((res, rej) => {
        if (failed) return rej(failed);
        pendingFinalize = { resolve: res, reject: rej };
        post({ type: "finalize", durationSec });
      });
      const deadline = new Promise<FinalizeStats>((res) => {
        deadlineTimer = setTimeout(() => {
          if (!pendingFinalize) return; // already finalized
          pendingFinalize = null; // stop the worker's late "finalized" from resolving
          report(
            "recorder-node",
            `finalize exceeded ${finalizeDeadlineMs}ms — terminating; truncated container left on disk`,
          );
          res(truncated);
        }, finalizeDeadlineMs);
        (deadlineTimer as { unref?: () => void }).unref?.();
      });
      const stats = await Promise.race([finalizePromise, deadline])
        .catch((e) => {
          report("recorder-node", `finalize failed: ${(e as Error).message}`);
          return truncated;
        })
        .finally(() => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        });
      await worker.terminate();
      // Disconnect any pipe still connected AFTER the worker's reads stop
      // (a stream that ended mid-run already released itself via stream-ended).
      for (const c of connections.values()) c.release();
      connections.clear();
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
      /** Wide camera intrinsics/distortion (already JSON-encoded string→string)
       *  → the `fovea:wide-camera` metadata record. */
      cameraMatrix?: Record<string, string>;
    }
  | { type: "add-stream"; stream: WorkerStreamInit }
  | { type: "remove-stream"; name: string }
  | { type: "add-data-stream"; name: string }
  | { type: "remove-data-stream"; name: string }
  | { type: "data"; name: string; payload: string }
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
const WIDE_CAMERA_METADATA_NAME = ${JSON.stringify(WIDE_CAMERA_METADATA_NAME)};
const RAW_FRAME_SCHEMA_NAME = ${JSON.stringify(RAW_FRAME_SCHEMA_NAME)};
const RAW_FRAME_SCHEMA_DATA = ${JSON.stringify(RAW_FRAME_SCHEMA_DATA)};
const RAW_FRAME_MESSAGE_ENCODING = ${JSON.stringify(RAW_FRAME_MESSAGE_ENCODING)};
const DESCRIPTOR_SCHEMA_NAME = ${JSON.stringify(DESCRIPTOR_SCHEMA_NAME)};
const DESCRIPTOR_SCHEMA_DATA = ${JSON.stringify(DESCRIPTOR_SCHEMA_DATA)};
const DESCRIPTOR_MESSAGE_ENCODING = ${JSON.stringify(DESCRIPTOR_MESSAGE_ENCODING)};
const TELEMETRY_TOPIC = ${JSON.stringify(TELEMETRY_TOPIC)};
const TELEMETRY_SCHEMA_NAME = ${JSON.stringify(TELEMETRY_SCHEMA_NAME)};
const TELEMETRY_SCHEMA_DATA = ${JSON.stringify(TELEMETRY_SCHEMA_DATA)};
const TELEMETRY_MESSAGE_ENCODING = ${JSON.stringify(TELEMETRY_MESSAGE_ENCODING)};

// The unit-tested FIFO state machine, embedded verbatim (zero drift).
const runStreamConsumer = (${runStreamConsumer.toString()});

const initialStreams = workerData.streams;
const encoder = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const nowNs = () => BigInt(Math.round(now() * 1e6));

let handle = null;
let writer = null;
let position = 0n;
let maxQueued = ${DEFAULT_MAX_QUEUED_FRAMES};
let durationSec = 0;
// finalizeRequested: stop() posted — reject late add-*; snapshot drain targets.
// finalized: the container's end() sequence began — no more writes admitted.
let finalizeRequested = false;
let finalized = false;
let statsTimer = null;
const channelIds = new Map();

// The write chain only starts once the writer is up (readyResolve fires at the
// tail of "start"), so a consumer whose add-stream raced "start" queues its
// first writer touch instead of hitting a null writer.
let readyResolve;
let chain = new Promise((r) => { readyResolve = r; });

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

// DYNAMIC per-stream state. streamsByName/consumers grow + SHRINK with churn;
// counters/writeSeq/registered PERSIST across a stream's end (totals stay
// truthful; re-adding a name continues its channel + mcap sequence). drainTargets
// carries the R-1 finalize/remove snapshot.
const streamsByName = new Map();  // name -> live stream {…init, h, dst}
const consumers = new Map();      // name -> consumer Promise
const counters = {};              // name -> {ingested,dropped,written,bytes}
const writeSeq = {};              // name -> next mcap sequence
const pending = {};               // name -> in-flight writes (backpressure)
const waiters = {};               // name -> afterWrite resolver | null
const registered = new Set();     // frame channels registered in the container
const dataChannels = new Set();   // data (descriptor) channels currently open
const dataSeq = {};               // data channel name -> next sequence

parentPort.on("message", (m) => {
  if (m.type === "start") {
    enqueueStart(m);
  } else if (m.type === "add-stream") {
    // Add-after-finalize is ignored worker-side (main also rejects it typed).
    if (finalizeRequested) return;
    if (!streamsByName.has(m.stream.name)) openAndStart(m.stream);
  } else if (m.type === "remove-stream") {
    setDrainTarget(m.name);
  } else if (m.type === "add-data-stream") {
    if (finalizeRequested) return;
    addDataChannel(m.name);
  } else if (m.type === "remove-data-stream") {
    // Descriptor channels have no pipe/consumer — the channel STAYS in the
    // container; we just stop admitting further writes for it.
    dataChannels.delete(m.name);
  } else if (m.type === "data") {
    writeData(m.name, m.payload);
  } else if (m.type === "finalize") {
    durationSec = m.durationSec;
    finalizeRequested = true;
    // Snapshot every LIVE producer's latest so its consumer drains the buffered
    // tail then stops (R-1 semantics without racing the pipe close).
    for (const name of streamsByName.keys()) setDrainTarget(name);
    maybeFinalize(); // no live consumers (all already ended) → finalize now
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

function setDrainTarget(name) {
  const s = streamsByName.get(name);
  if (!s) return; // already ended / never added
  try {
    const latest = reader.latestSeq(s.h);
    drainTargets[name] = typeof latest === "bigint" ? latest : BigInt(latest);
  } catch { drainTargets[name] = -1n; }
}
const drainTargets = {}; // name -> bigint | null (null = keep reading)

function enqueueStart(m) {
  return (async () => {
    maxQueued = m.maxQueuedFrames;
    handle = await open(m.filePath, "w");
    writer = new McapWriter({ writable, chunkSize: m.chunkBytes });
    await writer.start({ profile: FOVEA_PROFILE, library: m.session.app });
    await writer.addMetadata({
      name: SESSION_METADATA_NAME,
      metadata: new Map(Object.entries(m.session)),
    });
    // Global singleton (multi-fovea-recording r2 ruling 2): the wide camera's
    // intrinsics + distortion, written ONCE — applies to every wide frame.
    if (m.cameraMatrix) {
      await writer.addMetadata({
        name: WIDE_CAMERA_METADATA_NAME,
        metadata: new Map(Object.entries(m.cameraMatrix)),
      });
    }
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
    readyResolve(); // release the write chain now the writer is up
    startStatsTimer();
    for (const s of initialStreams) openAndStart(s);
  })().catch(report);
}

function initStreamState(name) {
  // PERSIST across re-add (channel + sequence continue); RESET the per-run
  // backpressure + drain state so a re-added stream reads fresh.
  if (counters[name] === undefined) counters[name] = { ingested: 0, dropped: 0, written: 0, bytes: 0 };
  if (writeSeq[name] === undefined) writeSeq[name] = 0;
  pending[name] = 0;
  waiters[name] = null;
  drainTargets[name] = null;
}

function openAndStart(s) {
  s.h = reader.open(s.shmName);
  s.dst = new Uint8Array(s.maxBytes);
  initStreamState(s.name);
  streamsByName.set(s.name, s);
  const p = makeConsumer(s)
    .catch(report)
    .finally(() => onConsumerExit(s));
  consumers.set(s.name, p);
}

function onConsumerExit(s) {
  consumers.delete(s.name);
  streamsByName.delete(s.name);
  try { reader.close(s.h); } catch {}
  // Tell main the consumer is done (drain / finalize / pipe-CLOSED) so it can
  // disconnect that pipe. The MCAP channel STAYS registered.
  post({ type: "stream-ended", name: s.name });
  maybeFinalize();
}

function registerFrameChannel(s) {
  const shape = s.channels > 1 ? [s.height, s.width, s.channels] : [s.height, s.width];
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
      // Advert fields copied VERBATIM (ruling 8): no interpretation. pixelFormat
      // is opaque (may carry codec suffixes); stride/significantBits are the
      // advert's own numbers, never recomputed here.
      metadata: new Map(Object.entries({
        dtype: s.dtype,
        shape: JSON.stringify(shape),
        width: String(s.width),
        height: String(s.height),
        channels: String(s.channels),
        pixelFormat: s.pixelFormat,
        significantBits: String(s.significantBits),
        stride: String(s.stride),
      })),
    });
    channelIds.set(s.name, channelId);
  });
}

function addDataChannel(name) {
  if (dataChannels.has(name)) return; // one channel per name
  dataChannels.add(name);
  if (dataSeq[name] === undefined) dataSeq[name] = 0;
  if (registered.has("data:" + name)) return; // channel already in the container
  registered.add("data:" + name);
  enqueue(async () => {
    const schemaId = await writer.registerSchema({
      name: DESCRIPTOR_SCHEMA_NAME,
      encoding: "jsonschema",
      data: encoder.encode(DESCRIPTOR_SCHEMA_DATA),
    });
    const channelId = await writer.registerChannel({
      schemaId,
      topic: name,
      messageEncoding: DESCRIPTOR_MESSAGE_ENCODING,
      metadata: new Map(),
    });
    channelIds.set(name, channelId);
  });
}

function writeData(name, payload) {
  if (finalized) return;
  if (!dataChannels.has(name)) return; // never added / removed
  // logTime = the worker axis clock (single monotonic container axis), stamped
  // at receipt; the observation time rides the doc's own tNs field.
  const logTimeNs = nowNs();
  const seq = dataSeq[name]++;
  enqueue(async () => {
    if (finalized) return;
    const channelId = channelIds.get(name);
    if (channelId === undefined) return;
    await writer.addMessage({
      channelId,
      sequence: seq,
      logTime: logTimeNs,
      publishTime: logTimeNs,
      data: encoder.encode(payload),
    });
  });
}

function releaseWaiter(name) {
  const w = waiters[name];
  if (w) { waiters[name] = null; w(); }
}

function makeConsumer(s) {
  let startSeq;
  try {
    const latest = reader.latestSeq(s.h);
    const l = typeof latest === "bigint" ? latest : BigInt(latest);
    startSeq = l > 0n ? l : 1n;
  } catch { startSeq = 1n; }
  return runStreamConsumer({
    dst: s.dst,
    startSeq,
    // FALLBACK length only (ring v4 reports no per-frame bytes) — the advert's
    // fixed frame size, NEVER dim-derived. Ring v5's per-frame bytes supersede it.
    bytesFor: () => s.frameBytes,
    read: (want) => reader.readSeqInto(s.h, s.dst, want),
    delay: () => sleep(2),
    drainTarget: () => drainTargets[s.name],
    onDrop: (n) => { if (n > 0) counters[s.name].dropped += n; },
    onFrame: (view, seq, width, height, deviceTs) => {
      if (!registered.has(s.name)) { registered.add(s.name); registerFrameChannel(s); }
      counters[s.name].ingested += 1;
      const outSeq = writeSeq[s.name]++;
      // logTimeNs = the container time AXIS (worker monotonic clock, shared by
      // EVERY channel incl. telemetry — keeps the viewer seek domain single-
      // clock/0-based). tNs = the TRUSTED capture time: the frame's device
      // timestamp when the source stamps it (R-2 fix), else the axis clock.
      const logTimeNs = nowNs();
      const tNs = typeof deviceTs === "bigint" ? deviceTs : logTimeNs;
      // ONE copy: reused SHM read buffer → an owned ArrayBuffer for the chain.
      // No unpacking, no header — the payload is written exactly as read.
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
      // Ruling-3: notify main of the NEW frame (extras ride back async), but
      // ONLY for streams the session can inject extras for (R-2 opt) — a
      // no-extras stream (e.g. center wide) skips the pointless main round-trip.
      // Carry BOTH clocks: the axis time so the telemetry doc co-clocks with its
      // frame, and the trusted capture time for the FIN-correlation 't' field.
      if (s.wantsExtras) post({ type: "frame", stream: s.name, seq: outSeq, logTimeNs, tNs });
    },
    afterWrite: () => {
      // Yield so the writer chain advances; block while the channel window is
      // full (surfaces as ring Gone drops on resume — never an unbounded queue).
      if (pending[s.name] < maxQueued) return Promise.resolve();
      return new Promise((r) => { waiters[s.name] = r; });
    },
  });
}

function startStatsTimer() {
  statsTimer = setInterval(() => post({ type: "stats", streams: statsSnapshot() }), 250);
  statsTimer.unref && statsTimer.unref();
}

// Iterate the COUNTERS map (not a startup array): it keeps ended streams so the
// totals stay truthful across churn.
function statsSnapshot() {
  const snapshot = {};
  for (const name of Object.keys(counters)) snapshot[name] = { ...counters[name] };
  return snapshot;
}

// Finalize once stop() was requested AND every consumer ever started (including
// late-added ones) has drained + exited. Runs at most once.
function maybeFinalize() {
  if (!finalizeRequested || finalized || consumers.size > 0) return;
  finalized = true; // stop admitting extras/data before the non-reentrant end()
  // Append the end() sequence AFTER all pending frame/data writes on the chain.
  chain = chain
    .then(async () => {
      if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
      let stats = { messageCount: "0", chunkCount: 0, bytes: Number(position) };
      if (writer) {
        await writer.addMetadata({
          name: FINALIZE_METADATA_NAME,
          metadata: new Map(Object.entries({ durationSec: String(durationSec) })),
        });
        await writer.end();
        const st = writer.statistics;
        await handle.close();
        stats = { messageCount: String(st ? st.messageCount : 0), chunkCount: st ? st.chunkCount : 0, bytes: Number(position) };
      }
      // Final stats push so the UI shows the last frames, then finalize.
      post({ type: "stats", streams: statsSnapshot() });
      post({ type: "finalized", stats });
    })
    .catch(report);
}
`;
