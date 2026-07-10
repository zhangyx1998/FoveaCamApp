// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// native-recorder Wave 3: the RECORDER NODE is now a THIN DRIVER over the
// native recorder brick (`core.Recorder.*` — core/lib/Record/RecorderStream).
// The brick owns the WHOLE write path in C++: producer-seam record taps on the
// SAME pipes this node used to FIFO-read (raw camera publishers, CompressStream
// /zlib outputs, derived bricks — advert-verbatim, byte-for-byte what the ring
// carried), bounded drop-oldest queues, a free-running writer thread hosting
// the hand-rolled McapWriter (docs/proposals/native-recorder.md). The one-JS-
// worker consume+encode chain this file used to embed is DELETED: nothing
// per-frame crosses JS in either direction — the host polls stats + ruling-3
// frame notices on a low-rate timer and forwards extras back as native
// enqueues.
//
// What this host still owns (the JS-visible surface is UNCHANGED — recording-
// service.ts and every session composition are untouched):
//   - the broker pipe connects (refcount++ → C-21 gate → producer runs) and
//     their release ordering (the tap detach is synchronous, so removeStream
//     releases its pipe immediately — no async stream-ended dance);
//   - the `recorder/<session>` graph row + workload meter, fed by
//     `foldStreamStats` over the brick's cumulative counters (same
//     StreamCounters shape, same F2 drop attribution);
//   - the ruling-3 extras round-trip (`dispatchFrame` over drained notices →
//     `appendTelemetry`);
//   - the container layout INPUTS (schema.ts constants + advert-verbatim
//     channel metadata) — passed INTO the brick so docs/schema stays the single
//     source of truth.
//
// The pure parts (stats folding, extras dispatch) remain exported and
// unit-tested with fakes; the NATIVE seam is injected so vitest never loads
// native core. `SeqRead` stays exported for capture-node.ts (its bounded FIFO
// consumer still reads pipes in a JS worker — a legitimate SHM/JS boundary).

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { registerWorkload, type WorkloadHandle } from "./metering.js";
import { registerGraphWiring, type GraphWiring } from "./graph-topology.js";
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
  JSON_SCHEMA_ENCODING,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_QUEUED_FRAMES,
} from "./recorder/schema.js";

const requireFromHere = createRequire(import.meta.url);

// ============================================================================
// KEPT for capture-node.ts (its bounded FIFO consumer classifies reads with
// this exact shape — core/test/29-raw-pipe.ts is canonical).
// ============================================================================

/** The `readSeqInto` classification: a frame (`seq`), NotYet (not published —
 *  retry), Gone (slot recycled — jump + drop-account), Closed (pipe retired —
 *  drain done), or `null` (torn seqlock read — retry the same seq). */
export type SeqRead =
  | null
  | { closed: true }
  | { notYet: true }
  | { gone: true; oldestSeq: bigint }
  | {
      seq: bigint;
      width: number;
      height: number;
      /** ACTUAL payload byte length (ring v5 `payloadBytes`); absent on v4. */
      bytes?: number;
      /** Capture-time metadata (BigInt ns; present when the source stamps it). */
      meta?: { deviceTimestamp?: bigint; systemTimestamp?: bigint };
    };

// ============================================================================
// PURE PART 1 — native counters → meter stats folding (low-rate, never per
// frame). UNCHANGED from the worker era: the native brick exposes the SAME
// cumulative counter shape, so the fold (and its tests) carry over verbatim.
// ============================================================================

/** Cumulative per-stream counters the native brick exposes (monotonic totals;
 *  `written + dropped == ingested`, `droppedQueue + droppedRing == dropped`). */
export interface StreamCounters {
  /** Frames that reached the recorder tap (admitted to the write path). */
  ingested: number;
  /** Total shed frames (accounted, never silent). */
  dropped: number;
  /** F2 attribution — shed while the writer was mid-encode/write (the mcap
   *  chain can't keep up: tune the queue cap / write batching). */
  droppedQueue: number;
  /** F2 attribution — shed while the writer was between items (an arrival
   *  burst outran the drain). */
  droppedRing: number;
  /** Frames the native writer encoded + wrote. */
  written: number;
  /** Frame payload bytes written. */
  bytes: number;
}

/** Per-stream folding state kept on the main side (last-seen totals + fps). */
export interface StreamFold {
  prev: StreamCounters;
  fps: FreqMeter;
}

/** The recording-telemetry row shape the UI expects (unchanged). */
export type RecorderStreamStats = StreamStats;

/** Fold the brick's cumulative counters into the graph meter (as DELTAS) and
 *  the per-stream UI stats. Pure over the injected meter + fold state; the host
 *  drives it on the low-rate poll, so no per-frame meter traffic. */
export function foldStreamStats(
  meter: Pick<WorkloadHandle, "ingest" | "emit" | "drop">,
  folds: Map<string, StreamFold>,
  incoming: Record<string, StreamCounters>,
): Record<string, RecorderStreamStats> {
  const out: Record<string, RecorderStreamStats> = {};
  for (const [name, next] of Object.entries(incoming)) {
    let fold = folds.get(name);
    if (!fold) {
      fold = {
        prev: { ingested: 0, dropped: 0, droppedQueue: 0, droppedRing: 0, written: 0, bytes: 0 },
        fps: new FreqMeter(),
      };
      folds.set(name, fold);
    }
    const { prev } = fold;
    const dIngest = Math.max(0, next.ingested - prev.ingested);
    const dDropQueue = Math.max(0, next.droppedQueue - prev.droppedQueue);
    const dDropRing = Math.max(0, next.droppedRing - prev.droppedRing);
    const dWritten = Math.max(0, next.written - prev.written);
    const dBytes = Math.max(0, next.bytes - prev.bytes);
    if (dIngest) meter.ingest(name, dIngest);
    // F2 attribution: split drop causes into distinct meter reasons (they sum to
    // the old single "ring-recycled" total, so the drop invariant is unchanged).
    if (dDropQueue) meter.drop("queue-overflow", dDropQueue);
    if (dDropRing) meter.drop("ring-recycled", dDropRing);
    if (dWritten) meter.emit("written", dWritten);
    if (dBytes) meter.emit("bytes", dBytes);
    for (let i = 0; i < dWritten; i++) fold.fps.tick();
    fold.prev = next;
    out[name] = {
      frames: next.written,
      dropped: next.dropped,
      droppedQueue: next.droppedQueue,
      droppedRing: next.droppedRing,
      bytes: next.bytes,
      fps: fold.fps.value,
    };
  }
  return out;
}

// ============================================================================
// PURE PART 2 — ruling-3 per-frame metadata dispatch (extras correlation).
// UNCHANGED: only the post target moved (worker postMessage → native enqueue).
// ============================================================================

/** The session's ruling-3 handler: given a NEW frame's stream + seq + TRUSTED
 *  capture time (`tNs`, ns — device time when the source stamps it, else the
 *  container axis clock), return per-frame extras to ride the telemetry
 *  channel, or null. This `tNs` is the value future FIN pairing correlates on.
 *  NEVER blocks the frame write (the host invokes it AFTER the frame message
 *  was already written natively). */
export type OnRecordedFrame = (
  stream: string,
  seq: number,
  tNs: bigint,
) => Record<string, unknown> | null | undefined;

/** A native "new frame" notice. Two clocks travel together:
 *  - `logTimeNs` — the container time AXIS the frame was written at (the
 *    brick's steady clock, shared across every channel; the telemetry doc
 *    MUST reuse it as its message `logTime` so the viewer's relative-time seek
 *    domain stays single-clock — see viewer/source.ts).
 *  - `tNs` — the frame's TRUSTED capture time (device time when stamped, else
 *    equal to `logTimeNs`); the FIN-correlation value carried in the telemetry
 *    doc's `t` field. */
export interface FrameNotice {
  stream: string;
  seq: number;
  logTimeNs: bigint;
  tNs: bigint;
}

/** The extras message posted back (telemetry doc correlated by stream+seq).
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
 * time in SECONDS — the exact legacy `telemetry` channel shape) and post it
 * with the OWNING frame's `logTimeNs` (so the telemetry message logs on the
 * same container axis as its frame). Returns the message posted (or null when
 * there are no extras / no callback). Pure over the injected callback + post
 * fn — a late/absent reply just means the frame carries no extras, never a
 * stall.
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
// The native seam — the exact `core.Recorder.*` surface the host drives,
// INJECTED so vitest exercises the host with a fake and never loads core.
// ============================================================================

/** Finalize result as the native promise resolves it. */
export interface NativeFinalizeStats {
  messageCount: bigint;
  chunkCount: number;
  bytes: number;
}

/** The `core.Recorder` subset the host drives (see core/dist/index.d.ts). */
export interface RecorderNative {
  create(opts: {
    id: string;
    filePath: string;
    chunkBytes: number;
    maxQueuedFrames: number;
    profile: string;
    library: string;
    sessionMetaName: string;
    wideCameraMetaName: string;
    finalizeMetaName: string;
    session: Record<string, string>;
    cameraMatrix?: Record<string, string>;
    rawFrameSchemaName: string;
    rawFrameSchemaData: string;
    descriptorSchemaName: string;
    descriptorSchemaData: string;
    telemetrySchemaName: string;
    telemetrySchemaData: string;
    schemaEncoding: string;
    rawFrameEncoding: string;
    descriptorEncoding: string;
    telemetryEncoding: string;
    telemetryTopic: string;
  }): number;
  addStream(
    handle: number,
    name: string,
    pipeId: string,
    metadata: Record<string, string>,
    wantsExtras: boolean,
  ): void;
  removeStream(handle: number, name: string): void;
  addDataStream(handle: number, name: string): void;
  removeDataStream(handle: number, name: string): void;
  postData(handle: number, name: string, payloadJson: string): void;
  appendTelemetry(handle: number, seq: number, logTimeNs: bigint, payloadJson: string): void;
  takeNotices(handle: number): FrameNotice[];
  stats(handle: number): Record<string, StreamCounters>;
  finalize(handle: number, durationSec: number): Promise<NativeFinalizeStats>;
  abort(handle: number): void;
  destroy(handle: number): void;
}

/** Production default: the real `core.Recorder` namespace, required lazily so
 *  importing this module (vitest, type-only consumers) never loads native core. */
function defaultNative(): RecorderNative {
  const core = requireFromHere("core") as { Recorder: RecorderNative };
  return core.Recorder;
}

// ============================================================================
// The node host — broker connects, graph row + meter, low-rate poll, lifecycle.
// ============================================================================

/** A connected pipe segment the recorder taps: its shm name + decode geometry
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
    /** Fixed per-frame size (advert). */
    bytesPerFrame: number;
    /** Advert row stride (bytes/row). Copied VERBATIM to metadata; the recorder
     *  never computes it (packed 12p / codec streams own the number). */
    stride?: number;
    /** Advert significant-bit depth. Copied VERBATIM — NOT derived from
     *  `pixelFormat` (a codec-suffixed name would defeat the registry lookup). */
    significantBits?: number;
    /** C-20 slot size (over-provisioned). */
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
   *  brick independently; this is the trusted correlation time in the doc. */
  tNs: number;
  bbox: { x: number; y: number; width: number; height: number };
  // Pointers are NULLABLE (wave I-2): free-run recordings carry left/right =
  // null (no trigger-mode pair bound the exposure, pairing-nodes ruling 1); an
  // evicted/unmatched dts key is likewise null rather than absent. Offline
  // readers treat null and missing identically (no frame binds).
  frames: {
    left?: number | null;
    center?: number | null;
    right?: number | null;
  };
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
  /** Graph node id — `recorder/<session>`. */
  id: string;
  /** Container path: `<path>.fcap` (extension appended unless already present)
   *  — one file per recording, no per-recording directory. */
  path: string;
  /** name → pipe. Names are the container channel names. */
  streams: Record<string, { pipeId: string }>;
  /** Connect each named pipe (refcount++ → C-21 gate → producer runs). The
   *  connect drives the producer exactly as before; the brick taps the
   *  producer seam instead of reading the ring. */
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
  /** R-2 opt: the streams `onFrame` can actually return extras for. The brick
   *  produces a per-frame notice (and the host invokes `onFrame`) ONLY for
   *  these. Omit ⇒ every stream posts notices (backward-compatible). */
  extrasStreams?: string[];
  /** Test seam: the native recorder surface (default: `core.Recorder`). */
  native?: RecorderNative;
  /** mcap chunk threshold (default DEFAULT_CHUNK_BYTES). */
  chunkBytes?: number;
  /** Per-stream bounded pending window before drop-oldest (default 8). */
  maxQueuedFrames?: number;
  /** Stats + notices poll cadence (ms, default 250). */
  pollMs?: number;
  /** R-2: hard ceiling on `stop()`'s finalize wait (ms, default 30_000). A
   *  wedged finalize must NEVER hang session teardown / hardware quiescence:
   *  on expiry we log, abort the native recorder (crash-shape container left
   *  on disk — the documented contract), release the pipes in order, and
   *  return truncated stats. */
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
  /** Stop recording a frame stream: the brick detaches its tap synchronously
   *  (queued frames still write; the MCAP channel STAYS registered), then the
   *  pipe is disconnected immediately. No-op for unknown/removed names. */
  removeStream(name: string): void;
  /** Register a data (descriptor) channel MID-RECORDING — one JSON channel per
   *  live target. Legal only before `stop()`. Re-adding a live name is a no-op. */
  addDataStream(name: string): void;
  /** Write one descriptor to a data channel (through the brick's queue, so it
   *  never blocks a frame write). Silently dropped if the channel was never
   *  added / was removed / the container is finalizing. */
  postData(name: string, message: FoveaDescriptor): void;
  /** Retire a data channel: the channel STAYS in the container; later
   *  `postData` for it is dropped. No pipe to release (data is pushed). */
  removeDataStream(name: string): void;
  /** Finalize the container (R-1 drain: detach every tap, drain the queue
   *  snapshot, write the mcap summary/index, close), disconnect pipes, and
   *  retire the graph node. Resolves with the finalize stats. */
  stop(): Promise<FinalizeStats>;
}

const FRAME_STREAM = (pixelFormat: string, dtype: string): StreamType => ({
  kind: "frame",
  pixelFormat,
  // `dtype` came from an advertised pipe spec (a schema Dtype) — trusted narrow.
  dtype: dtype as ContainerDtype,
});

/** Advert → the brick's channel metadata map: format fields copied VERBATIM
 *  (the recorder is a format-agnostic socket — no interpretation; ruling 8).
 *  Shared by initial + churned streams so nothing can diverge. Exactly the
 *  fields (and stride fallback) the JS worker wrote. */
export function channelMetadata(spec: RecorderPipeConnection["spec"]): Record<string, string> {
  const shape =
    spec.channels > 1 ? [spec.height, spec.width, spec.channels] : [spec.height, spec.width];
  const stride =
    spec.stride ??
    (spec.height > 0 ? Math.floor(spec.bytesPerFrame / spec.height) : spec.bytesPerFrame);
  return {
    dtype: spec.dtype,
    shape: JSON.stringify(shape),
    width: String(spec.width),
    height: String(spec.height),
    channels: String(spec.channels),
    pixelFormat: spec.pixelFormat,
    significantBits: String(spec.significantBits ?? 0),
    stride: String(stride),
  };
}

/**
 * Create the recorder node. Connects every named pipe, creates the native
 * recorder brick + taps, registers the `recorder/<session>` graph row (+
 * per-stream input edges) and its meter, and drives the ruling-3 callback
 * round-trip on a low-rate poll. `stop()` finalizes.
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
    pollMs = 250,
    finalizeDeadlineMs = 30_000,
  } = options;
  const native = options.native ?? defaultNative();
  // Default (no list): every stream posts notices — backward compatible.
  const wantsExtras = (name: string): boolean =>
    extrasStreams === undefined || extrasStreams.includes(name);

  const filePath = path.endsWith(FOVEA_EXTENSION)
    ? resolve(path)
    : resolve(`${path}${FOVEA_EXTENSION}`);

  // --- connect every INITIAL named pipe (refcount++ → gate → producer runs) --
  // `connections` is keyed by stream name so churn (add/remove) can release
  // exactly the right pipe; the graph `edges` array is MUTATED in place
  // (registerGraphWiring holds the object, wiringToReports re-reads it live).
  const connections = new Map<string, RecorderPipeConnection>();
  const edges: GraphWiring["edges"] = [];
  const streamNames: string[] = [];

  const frameEdge = (pipeId: string, name: string, conn: RecorderPipeConnection) => ({
    from: pipeId,
    to: id,
    port: name,
    type: FRAME_STREAM(conn.spec.pixelFormat, conn.spec.dtype),
    lossy: false, // bounded queue — lossless up to the window, drops accounted
  });

  const initial: Array<{ name: string; pipeId: string; conn: RecorderPipeConnection }> = [];
  for (const [name, { pipeId }] of Object.entries(streams)) {
    const conn = connect(pipeId);
    connections.set(name, conn);
    streamNames.push(name);
    edges.push(frameEdge(pipeId, name, conn));
    initial.push({ name, pipeId, conn });
  }

  const releaseAllConnections = (): void => {
    for (const c of connections.values()) c.release();
    connections.clear();
  };

  // --- create the native brick (container open + writer thread) -------------
  // JSON-encode the wide-camera singleton into the string→string metadata map
  // (nested arrays/numbers survive) — the exact legacy encoding.
  const cameraMatrix = options.cameraMatrix
    ? Object.fromEntries(
        Object.entries(options.cameraMatrix).map(([k, v]) => [
          k,
          typeof v === "string" ? v : JSON.stringify(v),
        ]),
      )
    : undefined;

  let handle: number;
  try {
    handle = native.create({
      id,
      filePath,
      chunkBytes,
      maxQueuedFrames,
      profile: FOVEA_PROFILE,
      library: FOVEA_LIBRARY,
      sessionMetaName: SESSION_METADATA_NAME,
      wideCameraMetaName: WIDE_CAMERA_METADATA_NAME,
      finalizeMetaName: FINALIZE_METADATA_NAME,
      session: { timestamp, app: FOVEA_LIBRARY },
      ...(cameraMatrix ? { cameraMatrix } : {}),
      rawFrameSchemaName: RAW_FRAME_SCHEMA_NAME,
      rawFrameSchemaData: RAW_FRAME_SCHEMA_DATA,
      descriptorSchemaName: DESCRIPTOR_SCHEMA_NAME,
      descriptorSchemaData: DESCRIPTOR_SCHEMA_DATA,
      telemetrySchemaName: TELEMETRY_SCHEMA_NAME,
      telemetrySchemaData: TELEMETRY_SCHEMA_DATA,
      schemaEncoding: JSON_SCHEMA_ENCODING,
      rawFrameEncoding: RAW_FRAME_MESSAGE_ENCODING,
      descriptorEncoding: DESCRIPTOR_MESSAGE_ENCODING,
      telemetryEncoding: TELEMETRY_MESSAGE_ENCODING,
      telemetryTopic: TELEMETRY_TOPIC,
    });
  } catch (err) {
    // Build failure unwind (20e8834 discipline): never leave a connected pipe
    // behind a throw — recording-service releases only its own acquisition,
    // the node's connects are ours to release.
    releaseAllConnections();
    throw err;
  }
  // Tap every initial stream (advert-verbatim metadata).
  try {
    for (const { name, pipeId, conn } of initial)
      native.addStream(handle, name, pipeId, channelMetadata(conn.spec), wantsExtras(name));
  } catch (err) {
    try {
      native.abort(handle);
      native.destroy(handle);
    } catch {
      /* best-effort — the throw below is the primary signal */
    }
    releaseAllConnections();
    throw err;
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
  // guard for `postData` (the brick also guards; this avoids the native call).
  const dataStreams = new Set<string>();
  // Set the instant `stop()` is entered so an in-flight add/post loses the race
  // deterministically (the brick also refuses late admissions; both guard).
  let finalizing = false;

  // --- the low-rate poll: stats fold + ruling-3 notice dispatch -------------
  const pollOnce = (): void => {
    uiStats = foldStreamStats(meter, folds, native.stats(handle));
    // Ruling-3: drain the brick's frame notices and, when the session callback
    // returns extras, ride them back on the telemetry channel (correlated by
    // stream+seq, co-clocked via the owning frame's logTimeNs). The frame is
    // ALREADY written natively; this never blocks it.
    for (const notice of native.takeNotices(handle)) {
      dispatchFrame(
        onFrame,
        (m) => native.appendTelemetry(handle, m.seq, m.logTimeNs, m.payload),
        notice,
      );
    }
  };
  const pollTimer = setInterval(() => {
    try {
      pollOnce();
    } catch (e) {
      report("recorder-node", `poll failed: ${(e as Error).message}`);
    }
  }, pollMs);
  (pollTimer as { unref?: () => void }).unref?.();

  /** Release the pipe + drop the graph edge for a REMOVED frame stream. */
  function releaseStream(name: string): void {
    const conn = connections.get(name);
    if (conn) {
      connections.delete(name);
      conn.release();
    }
    const i = edges.findIndex((e) => e.to === id && e.port === name);
    if (i >= 0) edges.splice(i, 1);
  }

  const startedAt = performance.now();
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
      try {
        native.addStream(handle, name, opts.pipeId, channelMetadata(conn.spec), wantsExtras(name));
      } catch (err) {
        releaseStream(name);
        throw err;
      }
    },
    removeStream(name: string): void {
      if (!connections.has(name)) return;
      // The brick detaches the tap SYNCHRONOUSLY (queued frames still write,
      // the channel stays registered), so the pipe releases immediately — the
      // worker era's async stream-ended dance is gone.
      native.removeStream(handle, name);
      releaseStream(name);
    },
    addDataStream(name: string): void {
      if (finalizing || stopped)
        throw new RecorderFinalizedError(`addDataStream("${name}") after finalize`);
      dataStreams.add(name);
      native.addDataStream(handle, name);
    },
    postData(name: string, message: FoveaDescriptor): void {
      if (finalizing || stopped || !dataStreams.has(name)) return;
      native.postData(handle, name, JSON.stringify(message));
    },
    removeDataStream(name: string): void {
      if (!dataStreams.delete(name)) return;
      native.removeDataStream(handle, name);
    },
    async stop(): Promise<FinalizeStats> {
      if (stopped) return { messageCount: "0", chunkCount: 0, bytes: 0 };
      stopped = true;
      finalizing = true;
      clearInterval(pollTimer);
      const durationSec = (performance.now() - startedAt) / 1000;
      const truncated: FinalizeStats = { messageCount: "0", chunkCount: 0, bytes: 0 };
      // One final drain BEFORE finalize so extras for the last written frames
      // still ride along (the brick refuses admissions after beginFinalize).
      try {
        pollOnce();
      } catch {
        /* stats/notices are best-effort on the way down */
      }
      // R-1 finalize with the R-2 hard deadline: a wedged writer must NEVER
      // hang teardown / hardware quiescence. On expiry: abort (crash-shape
      // container left on disk — the documented contract) and return truncated.
      const finalizePromise: Promise<FinalizeStats | null> = native
        .finalize(handle, durationSec)
        .then((s) => ({
          messageCount: String(s.messageCount),
          chunkCount: s.chunkCount,
          bytes: s.bytes,
        }))
        .catch((e) => {
          report("recorder-node", `finalize failed: ${(e as Error).message}`);
          return null;
        });
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((res) => {
        deadlineTimer = setTimeout(() => res(null), finalizeDeadlineMs);
        (deadlineTimer as { unref?: () => void }).unref?.();
      });
      let stats = await Promise.race([finalizePromise, deadline]);
      if (stats === null) {
        // Deadline expiry (or a finalize failure): abort unblocks the native
        // finalize waiter; give it a short grace so destroy() is safe. A writer
        // wedged in a syscall keeps its handle (leaked — process exit recovers),
        // matching the worker era's terminate best-effort.
        report(
          "recorder-node",
          `finalize exceeded ${finalizeDeadlineMs}ms or failed — aborting; ` +
            `truncated container left on disk`,
        );
        try {
          native.abort(handle);
        } catch {
          /* already gone */
        }
        const grace = new Promise<null>((res) => {
          const t = setTimeout(() => res(null), 1_000);
          (t as { unref?: () => void }).unref?.();
        });
        await Promise.race([finalizePromise, grace]);
        stats = truncated;
      }
      if (deadlineTimer) clearTimeout(deadlineTimer);
      // Final stats fold AFTER the drain completed so `stats()` reflects every
      // frame the finalize drain wrote (the worker era's final stats push).
      try {
        uiStats = foldStreamStats(meter, folds, native.stats(handle));
      } catch {
        /* best-effort on the way down */
      }
      try {
        native.destroy(handle);
      } catch (e) {
        report("recorder-node", `destroy failed: ${(e as Error).message}`);
      }
      // Disconnect every pipe still connected AFTER the brick stopped tapping.
      releaseAllConnections();
      meter.dispose();
      unregisterWiring();
      return stats;
    },
  };
}
