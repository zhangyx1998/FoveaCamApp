// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// capture-recorder-nodes Phase 3 (Wave I-3): the CAPTURE NODE. A worker thread
// (vision-worker host pattern — the worker runs `core/Vision`) that performs the
// bursty stack/wrap/diff/slice capture math at FULL BIT DEPTH off the
// orchestrator main JS loop. The held `pending` resources (16-bit BGRA foveae,
// sliced center, diff) live IN-WORKER until `save()`/`discard()`.
//
// ON-DEMAND PIPES (report): unlike the recorder (one long-lived connection), the
// capture node is IDLE between captures — it holds NO pipe consumer connection
// while parked. `capture()` connects the raw L/R producers on demand (the
// injected `acquireStreams` seam: advertise+attach the `camera/<serial>/raw`
// producer, refcount++ the broker → the C-21 gate fires → the capture-thread
// subscriber is created — see core/lib/Aravis/RawPipe.cpp), drains the burst,
// then releases (refcount-- → gate parks → the subscriber destructs → zero
// capture-thread cost). The center view rides the session's already-connected
// `undistort:<serial>` pipe (a fresh latest-wins read).
//
// The pure parts (the burst-grab seq loop, the indexed-resource accumulation
// state machine, the downconvert selection, the center rect clamp) are exported
// and unit-tested with fakes; the worker embeds them verbatim via `.toString()`
// (zero drift), exactly like recorder-node.ts's `runStreamConsumer`. The image
// math (stack/makeBGRA/wrapPerspective/diff/slice) is ported FAITHFULLY from the
// deleted `manual-control/capture.ts` and runs against the worker's required
// `core/Vision` — same call sequence, so the saved bytes match the pre-wave
// implementation (full-depth parity is the Wave R-3 audit item).

import { Worker, type TransferListItem } from "node:worker_threads";
import { createRequire } from "node:module";
import { registerWorkload, type WorkloadHandle } from "./metering.js";
import { registerGraphWiring, type GraphWiring } from "./graph-topology.js";
import { readerAddonPath } from "./vision-worker-host.js";
import { report } from "./diagnostics.js";
import type { SeqRead } from "./recorder-node.js";
import type { Serializable } from "@lib/orchestrator/protocol.js";
import type { FramePayload } from "@lib/orchestrator/protocol.js";

const requireFromHere = createRequire(import.meta.url);

// ============================================================================
// PURE PART 1 — burst grab (read N consecutive FRESH frames off a FIFO pipe).
// ============================================================================

/** Everything the burst consumer touches — all injected, so the loop is
 *  exercised in vitest with a fake reader and never loads native core. Mirrors
 *  recorder-node.ts's `StreamConsumerCfg`, but BOUNDED to `count` frames (a
 *  capture burst) instead of running until the pipe closes. */
export interface BurstCfg {
  /** FIFO read of `wantSeq` (the reader copies its bytes into `dst`). */
  read(wantSeq: bigint): SeqRead;
  /** Reused per-stream read buffer (SHM-consumer-reuse-buffer). */
  dst: Uint8Array;
  /** Active-frame byte length for the downstream copy. */
  bytesFor(width: number, height: number): number;
  /** One in-order frame — CONSUME IT SYNCHRONOUSLY (`dst` is overwritten by
   *  the next read). */
  onFrame(view: Uint8Array, seq: bigint, width: number, height: number): void;
  /** Account `n` ring-recycled frames (consumer lagged a full ring). */
  onDrop(n: number): void;
  /** Short backoff on NotYet (a caught-up, still-open pipe). */
  delay(): Promise<void>;
  /** First seq to request (the producer's latest+1 at connect — strictly
   *  FRESH frames, so a steer-then-capture never averages a pre-steer frame). */
  startSeq: bigint;
  /** Number of consecutive fresh frames to grab (the cap-stack count). */
  count: number;
}

/**
 * Grab up to `count` consecutive fresh frames in FIFO order, returning the
 * number actually delivered (`< count` iff the pipe closed early). The state
 * machine reuses recorder-node's loss contract, bounded to the burst:
 *  - `null` (torn read)  → retry the SAME seq
 *  - Closed              → stop (producer retired mid-burst — return short)
 *  - NotYet              → back off (waiting for the next fresh frame)
 *  - Gone                → account `oldest − want` drops, JUMP to `oldest`
 *  - Ok                  → deliver, `want = seq + 1`, until `count` delivered
 * Pure over `cfg`; drives production and the unit tests identically (the worker
 * embeds this exact function via `.toString()`).
 */
export async function grabBurst(cfg: BurstCfg): Promise<number> {
  let want = cfg.startSeq;
  let got = 0;
  while (got < cfg.count) {
    const r = cfg.read(want);
    if (r === null) continue; // torn seqlock read — retry the same seq
    if ("closed" in r) return got; // producer retired mid-burst
    if ("notYet" in r) {
      await cfg.delay();
      continue;
    }
    if ("gone" in r) {
      cfg.onDrop(Number(r.oldestSeq - want)); // recycled gap — accounted
      want = r.oldestSeq;
      continue;
    }
    cfg.onFrame(cfg.dst.subarray(0, cfg.bytesFor(r.width, r.height)), r.seq, r.width, r.height);
    want = r.seq + 1n;
    got += 1;
  }
  return got;
}

// ============================================================================
// PURE PART 2 — indexed-resource accumulation (capture.ts semantics, exact).
// ============================================================================

/** Where to store a resource this shot. `indexed` (a raster/multi-shot capture)
 *  → the resource ACCUMULATES as an array (one entry per shot, in call order),
 *  matching the old `Capture.capture()` `provide()`; unindexed → a single entry
 *  that REPLACES (matching a 1-shot capture / the once-captured "wide"). */
export function accumulate<T>(
  store: Map<string, T | T[]>,
  name: string,
  entry: T,
  indexed: boolean,
): number {
  if (!indexed) {
    store.set(name, entry);
    return -1; // unindexed
  }
  const existing = store.get(name);
  const arr = Array.isArray(existing) ? existing : [];
  if (!Array.isArray(existing)) store.set(name, arr);
  const index = arr.length;
  arr.push(entry);
  return index;
}

/** Build the resource → metadata manifest the renderer reads (`capture_meta`).
 *  Mirrors the deleted `publishMeta` EXACTLY: each resource maps to its meta
 *  (or `null` for an image-only resource), an ARRAY of them for an indexed
 *  resource. Insertion order is preserved (wide, fovea, center, left, right,
 *  diff). */
export function manifestOf<T>(
  store: Map<string, T | T[]>,
  metaOf: (entry: T) => Serializable,
): Record<string, Serializable> {
  const out: Record<string, Serializable> = {};
  for (const [name, entry] of store) {
    out[name] = (
      Array.isArray(entry) ? entry.map((e) => metaOf(e)) : metaOf(entry)
    ) as Serializable;
  }
  return out;
}

// ============================================================================
// PURE PART 3 — center rect clamp + downconvert selection.
// ============================================================================

/** Clamp a crop rect into the frame — ported verbatim from capture.ts's
 *  `clampRect` (integer-rounded, min 1×1, kept inside W×H). */
export function clampRect(
  r: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(Math.round(r.x), width - 1));
  const y = Math.max(0, Math.min(Math.round(r.y), height - 1));
  const w = Math.max(1, Math.min(Math.round(r.width), width - x));
  const h = Math.max(1, Math.min(Math.round(r.height), height - y));
  return { x, y, width: w, height: h };
}

/** A held resource previews at 8-bit BGRA: an already-8-bit resource (the
 *  sliced center) passes through; a full-depth (16-bit) resource is
 *  down-converted. Mirrors the deleted `publishFrame`'s
 *  `image instanceof Uint8Array ? image : convertType(image, "8U")`. */
export function needsDownconvert(bytesPerElement: number): boolean {
  return bytesPerElement > 1;
}

// ============================================================================
// The node host (main thread) — spawn/broker/meter/lifecycle only.
// ============================================================================

/** A left/right RAW stream connection the worker FIFO-drains for a burst. */
export interface CaptureStreamInit {
  shmName: string;
  maxBytes: number;
  channels: number;
  bytesPerElement: number;
  /** The sensor format's true bit depth — the stack alpha is 1/(2^bits − 1). */
  significantBits: number;
  /** Sensor format label (the demosaic branch in `makeBGRA`). */
  pixelFormat: string;
}

/** The center stream (the session's undistort pipe — 8-bit BGRA, latest-wins). */
export interface CaptureCenterInit {
  shmName: string;
  maxBytes: number;
  channels: number;
}

export interface CaptureStreams {
  left: CaptureStreamInit;
  right: CaptureStreamInit;
  center: CaptureCenterInit;
}

/** On-demand pipe seam (session-owned): advertise+attach the raw L/R producers,
 *  connect all three streams (refcount++ → gate → producers run), and return a
 *  `release` that disconnects + retires them (gate parks the producers). */
export type AcquireStreams = () => { streams: CaptureStreams; release: () => void };

/** One capture shot's calibration-derived transforms + per-resource metadata —
 *  computed on MAIN in the ruling-3 `onCaptureStart` snapshot and attached to
 *  the whole shot regardless of stack depth. */
export interface CaptureShot {
  /** Clear the held resources + (re)provide "wide" — the first shot of an
   *  accumulation session. */
  reset: boolean;
  /** Accumulate indexed (a raster shot) vs replace (a 1-shot capture). */
  indexed: boolean;
  /** Frames averaged per fovea (cap-stack). */
  stackCount: number;
  /** Fovea homographies (flat 3×3, Float64) — `wrapPerspective` aligns the
   *  stacked L/R foveae exactly as the live L/R views. */
  H_L: number[];
  H_R: number[];
  /** Center crop rect around the target (undistorted pixel space). */
  rect: { x: number; y: number; width: number; height: number };
  /** Per-resource metadata written as `<name>.json` on save. `wide` only
   *  rides the reset shot. */
  meta: {
    wide?: Serializable;
    fovea: Serializable;
    left: Serializable;
    right: Serializable;
  };
}

export interface CaptureNodeOptions {
  /** Graph node id — `capture/<session>` (composed in the session wrapper). */
  id: string;
  /** Pipe ids for the graph input edges (stable per session — the raw L/R
   *  producers + the center undistort pipe). Wiring only; the actual connect is
   *  per-run via `acquireStreams`. */
  graphInputs: { left: string; right: string; center: string };
  /** On-demand pipe connect/release (session-owned; see `AcquireStreams`). */
  acquireStreams: AcquireStreams;
  /** Test seam: spawn the worker (default: the eval'd WORKER_SOURCE). */
  spawn?: () => WorkerLike;
  /** Test seam: reader-addon path (default: parent-resolved). */
  readerPath?: string;
}

export interface CaptureNodeHandle {
  readonly id: string;
  /** Run one capture shot: connect the raw pipes on demand, drain the burst,
   *  stack/wrap/diff/slice in-worker, hold the resources, release the pipes.
   *  Resolves with the resource → metadata manifest (`capture_meta`). */
  capture(shot: CaptureShot): Promise<Record<string, Serializable>>;
  /** Pull one held resource's ACTUAL data downconverted to 8-bit BGRA (ruling
   *  7). Returns null for a meta-only resource / a bad index. */
  getPreview(resource: string, index?: number): Promise<FramePayload | null>;
  /** Persist the held resources to `path` (in-worker fs/encode). Clears them. */
  save(path: string, format: string): Promise<void>;
  /** Discard the held resources without saving. */
  discard(): Promise<void>;
  /** Terminate the worker + retire the graph node. */
  stop(): Promise<void>;
}

/** The `worker_threads.Worker` subset the host drives (injectable for tests). */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: readonly TransferListItem[]): void;
  on(event: "message", cb: (msg: CaptureNodeOut) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  terminate(): Promise<number> | void;
}

/** Per-run stream init the worker gets (shmNames + geometry). */
interface WorkerCaptureStreams {
  left: CaptureStreamInit;
  right: CaptureStreamInit;
  center: CaptureCenterInit;
}

/** main → worker protocol. */
export type CaptureNodeIn =
  | {
      type: "capture";
      runId: number;
      streams: WorkerCaptureStreams;
      shot: CaptureShot;
    }
  | { type: "getPreview"; reqId: number; resource: string; index?: number }
  | { type: "save"; reqId: number; path: string; format: string }
  | { type: "discard"; reqId: number };

/** worker → main protocol. */
export type CaptureNodeOut =
  | { type: "reading-done"; runId: number }
  | { type: "captured"; runId: number; manifest: Record<string, Serializable>; bursts: Record<string, number>; stackMs: number }
  | { type: "preview"; reqId: number; payload: FramePayload | null }
  | { type: "saved"; reqId: number }
  | { type: "discarded"; reqId: number }
  | { type: "error"; runId?: number; reqId?: number; message: string; stack?: string };

/**
 * Create the capture node. Registers the `capture/<session>` graph row (+ per-
 * stream input edges) and its meter, spawns the (idle) worker, and returns the
 * bursty capture/getPreview/save/discard surface. The worker holds NO pipe
 * connection while idle — `capture()` connects on demand and releases after the
 * drain (`acquireStreams`).
 */
export function createCaptureNode(options: CaptureNodeOptions): CaptureNodeHandle {
  const { id, graphInputs, acquireStreams } = options;

  // --- graph row + meter (per-run burst counts + stack timing) --------------
  const wiring: GraphWiring = {
    nodes: [{ id, kind: "capture", output: null, transport: "sink" }],
    edges: [
      { from: graphInputs.left, to: id, port: "left", type: { kind: "frame", pixelFormat: "sensor", dtype: "U16" }, lossy: false },
      { from: graphInputs.right, to: id, port: "right", type: { kind: "frame", pixelFormat: "sensor", dtype: "U16" }, lossy: false },
      { from: graphInputs.center, to: id, port: "center", type: { kind: "frame", pixelFormat: "bgra", dtype: "U8" }, lossy: true },
    ],
  };
  const unregisterWiring = registerGraphWiring(wiring);
  const meter: WorkloadHandle = registerWorkload(id, {
    inputs: ["left", "right", "center"],
    outputs: ["captured", "stackMs"],
  });

  const worker: WorkerLike = (options.spawn ?? defaultSpawn)();

  const post = (m: CaptureNodeIn, transfer?: TransferListItem[]): void =>
    worker.postMessage(m, transfer);

  // Per-run + per-request promise routing.
  let runId = 0;
  let reqId = 0;
  const pendingRuns = new Map<
    number,
    { resolve: (m: Record<string, Serializable>) => void; reject: (e: Error) => void; release: () => void; released: boolean }
  >();
  const pendingReqs = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  function releaseRun(run: { release: () => void; released: boolean } | undefined): void {
    if (run && !run.released) {
      run.released = true;
      try {
        run.release();
      } catch (e) {
        report("capture-node", `stream release failed: ${(e as Error).message}`);
      }
    }
  }

  worker.on("message", (msg: CaptureNodeOut) => {
    if (msg.type === "reading-done") {
      // The burst is fully copied out — park the raw producers NOW (the worker
      // no longer touches the pipes; the stack math finishes off the bytes).
      releaseRun(pendingRuns.get(msg.runId));
    } else if (msg.type === "captured") {
      const run = pendingRuns.get(msg.runId);
      pendingRuns.delete(msg.runId);
      releaseRun(run); // idempotent (already released on reading-done)
      // Meter: honest per-run burst counts + stack timing; parked = zero.
      meter.ingest("left", msg.bursts.left ?? 0);
      meter.ingest("right", msg.bursts.right ?? 0);
      meter.ingest("center", msg.bursts.center ?? 0);
      meter.emit("captured", 1);
      meter.emit("stackMs", Math.round(msg.stackMs));
      run?.resolve(msg.manifest);
    } else if (msg.type === "preview") {
      pendingReqs.get(msg.reqId)?.resolve(msg.payload);
      pendingReqs.delete(msg.reqId);
    } else if (msg.type === "saved" || msg.type === "discarded") {
      pendingReqs.get(msg.reqId)?.resolve(undefined);
      pendingReqs.delete(msg.reqId);
    } else {
      const err = Object.assign(new Error(msg.message), { stack: msg.stack });
      if (msg.runId !== undefined) {
        const run = pendingRuns.get(msg.runId);
        pendingRuns.delete(msg.runId);
        releaseRun(run);
        run?.reject(err);
      } else if (msg.reqId !== undefined) {
        pendingReqs.get(msg.reqId)?.reject(err);
        pendingReqs.delete(msg.reqId);
      } else {
        report("capture-node", err.message);
      }
    }
  });
  worker.on("error", (err) => {
    report("capture-node", err.message);
    for (const run of pendingRuns.values()) {
      releaseRun(run);
      run.reject(err);
    }
    pendingRuns.clear();
    for (const req of pendingReqs.values()) req.reject(err);
    pendingReqs.clear();
  });
  worker.on("exit", (code) => {
    // A non-zero code from the intentional `terminate()` in `stop()` is
    // expected; only an UNEXPECTED exit (worker died mid-session) is a fault.
    if (code !== 0 && !stopped) report("capture-node", `capture worker exited with code ${code}`);
  });

  function request<T>(build: (reqId: number) => CaptureNodeIn): Promise<T> {
    const rid = ++reqId;
    return new Promise<T>((resolve, reject) => {
      pendingReqs.set(rid, { resolve: resolve as (v: unknown) => void, reject });
      post(build(rid));
    });
  }

  let stopped = false;
  return {
    id,
    capture(shot: CaptureShot): Promise<Record<string, Serializable>> {
      const rid = ++runId;
      // Connect the raw pipes ON DEMAND (gate fires → producers run).
      const acquired = acquireStreams();
      return new Promise<Record<string, Serializable>>((resolve, reject) => {
        pendingRuns.set(rid, { resolve, reject, release: acquired.release, released: false });
        post({ type: "capture", runId: rid, streams: acquired.streams, shot });
      });
    },
    getPreview(resource, index) {
      return request<FramePayload | null>((reqId) => ({ type: "getPreview", reqId, resource, index }));
    },
    save(path, format) {
      return request<void>((reqId) => ({ type: "save", reqId, path, format }));
    },
    discard() {
      return request<void>((reqId) => ({ type: "discard", reqId }));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      // Release any straggler run (session teardown mid-capture).
      for (const run of pendingRuns.values()) releaseRun(run);
      pendingRuns.clear();
      await worker.terminate();
      meter.dispose();
      unregisterWiring();
    },
  };
}

function defaultSpawn(): WorkerLike {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      visionEntry: requireFromHere.resolve("core/Vision"),
      readerPath: readerAddonPath(),
    },
  }) as unknown as WorkerLike;
}

// ============================================================================
// The worker source (eval'd CJS — same reason recorder-node.ts eval's its own:
// the orchestrator bundles to a single file, so a sibling worker file would not
// exist at runtime; the `core/Vision` + reader-addon entry paths are resolved by
// the PARENT and handed in `workerData`). The pure burst/accumulate/manifest/
// clamp helpers are embedded verbatim via `.toString()` so the unit-tested logic
// and the production worker can never drift. The image math is ported FAITHFULLY
// from the deleted capture.ts (same `core/Vision` call sequence).
// ============================================================================

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { mkdirSync } = require("node:fs");
const fs = require("node:fs/promises");
const { resolve: resolvePath } = require("node:path");
const V = require(workerData.visionEntry);
const reader = require(workerData.readerPath);

// --- the unit-tested pure helpers, embedded verbatim (zero drift) -----------
const grabBurst = (${grabBurst.toString()});
const accumulate = (${accumulate.toString()});
const manifestOf = (${manifestOf.toString()});
const clampRect = (${clampRect.toString()});
const needsDownconvert = (${needsDownconvert.toString()});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function post(message, transfer) { parentPort.postMessage(message, transfer || []); }
function reportErr(fields, error) {
  post({
    type: "error",
    ...fields,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

// --- Mat helpers (makeMat = the @lib/mat shape/channels tag) -----------------
function makeMat(arr, shape, channels) { arr.shape = shape; arr.channels = channels; return arr; }

// makeBGR ported verbatim from @lib/imgproc (demosaic by sensor format).
function makeBGR(mat, format) {
  switch (format) {
    case "BayerBG8": case "BayerBG16": case "BayerBG12p": return V.cvtColor(mat, "BayerBG2BGR");
    case "BayerGB8": case "BayerGB16": case "BayerGB12p": return V.cvtColor(mat, "BayerGB2BGR");
    case "BayerRG8": case "BayerRG16": case "BayerRG12p": return V.cvtColor(mat, "BayerRG2BGR");
    case "BayerGR8": case "BayerGR16": case "BayerGR12p": return V.cvtColor(mat, "BayerGR2BGR");
  }
  switch (mat.channels) {
    case 1: return V.cvtColor(mat, "GRAY2BGR");
    case 3: return mat;
    case 4: return V.cvtColor(mat, "BGRA2BGR");
    default: throw new Error("Unsupported format: " + format + " with " + mat.channels + " channels");
  }
}
function makeBGRA(mat, format) { return V.cvtColor(makeBGR(mat, format), "BGR2BGRA"); }

// RGB2BGR ported verbatim from capture.ts (save-pipeline BGR order).
function RGB2BGR(image) {
  switch (image.channels) {
    case 4: return V.cvtColor(image, "RGBA2BGRA");
    case 3: return V.cvtColor(image, "RGB2BGR");
    default: return image;
  }
}

// The saved L/R foveae are ALWAYS perspective-wrapped into alignment (the wrap
// toggle was retired with the view re-plumb). Ported verbatim from capture.ts.
function normalizeFovea(image, H) {
  const bgra = makeBGRA(V.convertType(image, "16U"), H.format);
  return V.wrapPerspective(bgra, H.mat);
}

// The held resources (name -> Entry | Entry[]); Entry = { meta?, image? }.
const store = new Map();

// --- stack a burst of raw frames into a Float32 average (imgproc.stack) ------
async function stackStream(s, count) {
  const h = reader.open(s.shmName);
  const dst = new Uint8Array(s.maxBytes);
  const ElemCtor = s.bytesPerElement > 1 ? Uint16Array : Uint8Array;
  const alpha = 1 / ((1 << s.significantBits) - 1);
  let acc = null; // Float32 Mat accumulator
  let shape = null;
  let grabbed = 0;
  try {
    let startSeq;
    try {
      const latest = reader.latestSeq(h);
      const l = typeof latest === "bigint" ? latest : BigInt(latest);
      startSeq = l > 0n ? l + 1n : 1n;
    } catch { startSeq = 1n; }
    grabbed = await grabBurst({
      dst,
      startSeq,
      count,
      bytesFor: (w, hh) => w * hh * s.channels * s.bytesPerElement,
      read: (want) => reader.readSeqInto(h, dst, want),
      delay: () => sleep(1),
      onDrop: () => {},
      onFrame: (view, _seq, w, hh) => {
        // Reinterpret the reused byte buffer at the container width, wrap as a
        // Mat, scale to [0,1] by the format's TRUE bit depth, accumulate.
        const elems = w * hh * s.channels;
        const typed = new ElemCtor(view.buffer, view.byteOffset, elems);
        const raw = makeMat(typed, [hh, w], s.channels);
        const fp = V.convertType(raw, "32F", alpha, 0);
        if (acc === null) { acc = fp; shape = [hh, w]; }
        else { for (let i = 0; i < acc.length; i++) acc[i] += fp[i]; }
      },
    });
  } finally {
    try { reader.close(h); } catch {}
  }
  if (acc === null || grabbed === 0) throw new Error("capture: no frames on " + s.shmName);
  for (let i = 0; i < acc.length; i++) acc[i] /= grabbed;
  return { image: acc, grabbed };
}

// --- read ONE fresh center frame (latest-wins, strictly after start) ---------
async function readCenter(c, timeoutMs) {
  const h = reader.open(c.shmName);
  const dst = new Uint8Array(c.maxBytes);
  try {
    let lastSeq = reader.latestSeq(h); // skip whatever is already in the ring
    if (typeof lastSeq !== "bigint") lastSeq = BigInt(lastSeq);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = reader.readInto(h, dst, lastSeq);
      if (r !== null) {
        if ("closed" in r) return null;
        const len = r.width * r.height * c.channels;
        const view = dst.subarray(0, len);
        // Independent copy (dst is reused) → an 8-bit BGRA Mat.
        const copy = new Uint8Array(view);
        return makeMat(copy, [r.height, r.width], c.channels);
      }
      if (Date.now() > deadline) return null;
      await sleep(2);
    }
  } finally {
    try { reader.close(h); } catch {}
  }
}

// --- one capture shot --------------------------------------------------------
async function runCapture(m) {
  const { runId, streams, shot } = m;
  const t0 = now();
  const bursts = { left: 0, right: 0, center: 0 };

  // Drain the raw L/R bursts + the center frame, then signal reading-done so the
  // host parks the raw producers before the (pipe-free) stack math finishes.
  let lStack, rStack, centerRaw;
  try {
    [lStack, rStack, centerRaw] = await Promise.all([
      stackStream(streams.left, shot.stackCount),
      stackStream(streams.right, shot.stackCount),
      readCenter(streams.center, 2000),
    ]);
  } catch (e) {
    post({ type: "reading-done", runId });
    reportErr({ runId }, e);
    return;
  }
  bursts.left = lStack.grabbed;
  bursts.right = rStack.grabbed;
  bursts.center = centerRaw ? 1 : 0;
  post({ type: "reading-done", runId });

  try {
    if (centerRaw === null) throw new Error("capture: no center frame (undistort pipe timeout)");
    const { reset, indexed } = shot;
    if (reset) {
      store.clear();
      if (shot.meta.wide !== undefined) accumulate(store, "wide", { meta: shot.meta.wide }, false);
    }
    // fovea: meta only (Q / baseline computed on main).
    accumulate(store, "fovea", { meta: shot.meta.fovea }, indexed);
    // center: slice the undistorted view around the target (8-bit BGRA).
    const rect = clampRect(shot.rect, centerRaw.shape[1], centerRaw.shape[0]);
    accumulate(store, "center", { image: V.slice(centerRaw, rect) }, indexed);
    // left / right: stacked → normalized 16-bit BGRA, perspective-wrapped.
    const HL = { mat: makeMat(new Float64Array(shot.H_L), [3, 3], 1), format: streams.left.pixelFormat };
    const HR = { mat: makeMat(new Float64Array(shot.H_R), [3, 3], 1), format: streams.right.pixelFormat };
    const l = normalizeFovea(lStack.image, HL);
    const r = normalizeFovea(rStack.image, HR);
    accumulate(store, "left", { image: l, meta: shot.meta.left }, indexed);
    accumulate(store, "right", { image: r, meta: shot.meta.right }, indexed);
    accumulate(store, "diff", { image: V.diff(l, r, true) }, indexed);

    const manifest = manifestOf(store, (e) => (e && e.meta !== undefined ? e.meta : null));
    post({ type: "captured", runId, manifest, bursts, stackMs: now() - t0 });
  } catch (e) {
    reportErr({ runId }, e);
  }
}

// --- getPreview: downconvert the ACTUAL held resource to 8-bit BGRA ----------
function getPreview(m) {
  try {
    const entry = store.get(m.resource);
    let e = null;
    if (Array.isArray(entry)) e = m.index !== undefined ? entry[m.index] : entry[entry.length - 1];
    else e = entry;
    if (!e || !e.image) { post({ type: "preview", reqId: m.reqId, payload: null }); return; }
    const image = e.image;
    // Uint8Array resource passes through; a full-depth resource downconverts.
    const isU8 = image instanceof Uint8Array;
    const m8 = isU8 ? image : V.convertType(image, "8U");
    const bytes = new Uint8Array(m8.buffer, m8.byteOffset, m8.byteLength);
    const data = bytes.slice().buffer; // owned, transferable copy
    post(
      { type: "preview", reqId: m.reqId, payload: { data, shape: m8.shape, channels: m8.channels } },
      [data],
    );
  } catch (e) {
    reportErr({ reqId: m.reqId }, e);
  }
}

// --- save: port capture.ts's fs/encode (meta JSON + BGR-ordered image) -------
async function save(m) {
  try {
    const { path, format } = m;
    mkdirSync(path, { recursive: true });
    const tasks = [];
    for (const [name, items] of store) {
      if (Array.isArray(items)) {
        const directory = resolvePath(path, name);
        mkdirSync(directory, { recursive: true });
        const pad = Math.max(2, items.length.toString().length);
        for (let i = 0; i < items.length; i++) {
          const { meta, image } = items[i];
          const sequence = i.toString().padStart(pad, "0");
          if (meta !== undefined)
            tasks.push(fs.writeFile(resolvePath(directory, sequence + ".json"), JSON.stringify(meta, null, 2)));
          if (image)
            tasks.push(V.save(RGB2BGR(image), resolvePath(directory, sequence + "." + format)));
        }
      } else {
        const { meta, image } = items;
        if (meta !== undefined)
          tasks.push(fs.writeFile(resolvePath(path, name + ".json"), JSON.stringify(meta, null, 2)));
        if (image)
          tasks.push(V.save(RGB2BGR(image), resolvePath(path, name + "." + format)));
      }
    }
    await Promise.all(tasks);
    store.clear();
    post({ type: "saved", reqId: m.reqId });
  } catch (e) {
    reportErr({ reqId: m.reqId }, e);
  }
}

parentPort.on("message", (m) => {
  if (m.type === "capture") void runCapture(m);
  else if (m.type === "getPreview") getPreview(m);
  else if (m.type === "save") void save(m);
  else if (m.type === "discard") { store.clear(); post({ type: "discarded", reqId: m.reqId }); }
});
`;
