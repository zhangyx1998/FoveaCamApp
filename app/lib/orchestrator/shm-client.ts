// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer-side SHM transfer pool (C-P2, factored out of `client.ts`).
//
// The canonical preview transport hands the renderer an `shm` descriptor, not
// pixels: the actual read runs in the unsandboxed main-window preload (which
// alone can load the native reader addon), and the bytes come back over a
// dedicated `MessagePort` as a TRANSFERRED `ArrayBuffer`. This module owns that
// port handshake, the ping-pong buffer pool that recycles transferred buffers
// (so a steady stream doesn't churn allocations), the per-read timeout, and the
// message protocol with the preload. `client.ts` just calls `read()` in its
// frame flush and `release()` when a materialized frame is replaced/dropped.
//
// Buffer-ownership is the whole ballgame (MessagePort transfer moves ownership
// away and back). The invariants, mirrored by shm-client.test.ts:
//   - success  → buffer becomes `payload.data`; caller returns it via release()
//                once the frame is displaced.
//   - null     → no new frame this read; buffer is reclaimed to the pool here.
//   - error    → buffer reclaimed to the pool here; read rejects (→ null).
//   - timeout  → read rejects; the buffer is still in the preload's hands, so
//                it is reclaimed by the STALE-response path when the late
//                read-done arrives with no matching pending entry.
//   - stale    → read-done with no pending entry (already timed out / disposed)
//                → buffer reclaimed to the pool.
//
// Renderer-safe, Vue-free, core-free (type-only imports) like the rest of
// `@lib/orchestrator`.

import { frameByteLength } from "./frame-payload.js";
import type { FramePayload } from "./protocol.js";
import {
  PIPE_READ,
  PIPE_READ_DONE,
  PIPE_READ_SEQ,
  PIPE_READ_SEQ_DONE,
  SHM_INIT,
  SHM_READ,
  SHM_READ_DONE,
  type PipeReadDone,
  type PipeReadRequest,
  type PipeReadSeqDone,
  type PipeReadSeqRequest,
  type ShmReadDone,
  type ShmReadRequest,
} from "./shm-messages.js";
import {
  counterRate,
  ratePerSec,
  snapshotWindow,
  type CounterRate,
  type SampleStats,
  type SnapshotWindow,
  type WorkloadSnapshot,
} from "./stats.js";

/** Round-trip latency summary (ms). */
export type ShmLatencyStats = SampleStats;

/** Observe-only counters for the transfer pool (C-P9 surfaces these as a
 *  workload/OSD block). Never gate reads on any of these. */
export type ShmReadStats = {
  /** Transfer reads that returned a fresh frame. */
  reads: number;
  /** Transfer reads that returned null (no newer frame than `lastSeq`). */
  nulls: number;
  /** Reads that exceeded the transfer timeout before a reply arrived. */
  timeouts: number;
  /** Reads whose preload side threw (surfaced as `error`). */
  errors: number;
  /** Buffers freshly allocated because the pool had none of that size. */
  allocations: number;
  /** Buffers checked out from the pool (recycled, no allocation). */
  poolHits: number;
  /** Reads currently awaiting a reply from the preload. */
  inFlight: number;
  /** Cumulative stats window for all rates below. */
  window: SnapshotWindow;
  /** Rate view of the raw counters above. */
  rates: {
    reads: CounterRate;
    nulls: CounterRate;
    timeouts: CounterRate;
    errors: CounterRate;
    allocations: CounterRate;
    poolHits: CounterRate;
  };
  /** Profiler-friendly workload-shaped view of the same observe-only counts. */
  workload: WorkloadSnapshot;
  /** Round-trip latency of completed reads (reply received, not timed out). */
  latencyMs: ShmLatencyStats;
};

/** One frame read from a connected pipe (C-17). `data` is the pool buffer that
 *  now backs the pixels — return it via `releaseBuffer()` once displaced. */
export type PipeReadFrame = {
  data: ArrayBuffer;
  seq: bigint;
  tCapture?: number;
  /** Producer convert cost (ms) + seqlock health for this read (A-26 Fix D) —
   *  carried through so the consumer can populate `FramePayload.meta`/`.shm`
   *  and the StreamView inspector shows the same metrics on pipe streams. */
  convertMs?: number;
  gen?: number;
  retries?: number;
  /** Active frame size (C-20 dynamic resize) — the frame occupies
   *  `width*height*channels` bytes at the head of `data`. */
  width?: number;
  height?: number;
  /** Frame-bound crop origin in the parent stream (v4, fovea pipes) — absent /
   *  0 for uncropped streams. */
  originX?: number;
  originY?: number;
  /** Actual payload byte length the reader copied (ring v5 `payloadBytes`) —
   *  present only for a variable-length blob (compression pipes); absent on a
   *  dim-derived frame, where `width*height*channels` is the length. */
  bytes?: number;
};

/** A FIFO pipe read outcome (capture-recorder-nodes Phase 0). Mirrors the
 *  reader addon's `readSeqInto` classification so the recorder/capture consumer
 *  can drive an ordered, drop-accounted stream:
 *   - `PipeReadFrame`     `wantSeq` was delivered (`.seq === wantSeq`).
 *   - `"notyet"`          not published yet — short-poll/back off, retry same seq.
 *   - `{ gone, oldestSeq }` the slot recycled (lagged a full ring) — jump to
 *                          `oldestSeq`, account `wantSeq..oldestSeq-1` as drops.
 *   - `"closed"`          publisher closed, nothing newer will arrive — stop.
 *   - `null`              transient torn read — retry the same seq. */
export type PipeSeqReadResult =
  | PipeReadFrame
  | "notyet"
  | "closed"
  | { gone: true; oldestSeq: bigint }
  | null;

/** The transfer-pool surface `client.ts` consumes. */
export interface ShmClient {
  /** Materialize a frame payload: pass through if it already carries `data` or
   *  isn't an shm descriptor; otherwise transfer-read the pixels from the
   *  preload. Errors are swallowed to `null` (a dropped frame, never a throw on
   *  the display path). */
  read(payload: FramePayload): Promise<FramePayload | null>;
  /** Return a materialized shm frame's buffer to the pool. No-op for non-shm
   *  payloads (their buffers aren't pooled) and for null. */
  release(payload: FramePayload | null): void;
  /** Read the latest frame of a connected pipe by segment name, tracking
   *  `lastSeq` consumer-side (C-17). Resolves the frame (`data` = a pool
   *  buffer), `"closed"` when the publisher has closed, or `null` when no newer
   *  frame exists. Rejects on transport error/timeout (the consumer retries). */
  readPipe(
    shmName: string,
    lastSeq: bigint,
    bytes: number,
  ): Promise<PipeReadFrame | "closed" | null>;
  /** FIFO read of a SPECIFIC frame `wantSeq` from a connected pipe by segment
   *  name (capture-recorder-nodes Phase 0). Same pool/provisioning as `readPipe`
   *  (`bytes` = the ring SLOT size, `maxBytes ?? bytesPerFrame` — the C-20 rule);
   *  resolves the FIFO outcome (see `PipeSeqReadResult`). Rejects on transport
   *  error/timeout (the consumer retries the same seq). */
  readPipeSeq(
    shmName: string,
    wantSeq: bigint,
    bytes: number,
  ): Promise<PipeSeqReadResult>;
  /** Return a pipe frame's `data` buffer to the pool. */
  releaseBuffer(buffer: ArrayBuffer | null | undefined): void;
  /** Tear down: close the port, clear pending reads and the pool. Pending reads
   *  reject. Idempotent. */
  dispose(): void;
  /** Snapshot of the observe-only counters. */
  stats(): Readonly<ShmReadStats>;
}

/** Opens the transfer port to the preload, or null when unavailable (SSR /
 *  non-DOM). Default handshake: a `MessageChannel` whose far port is posted to
 *  the preload via `window.postMessage({kind:"fovea:shm:init"})`. Injectable so
 *  tests can supply a fake preload loop. */
export type ShmPortOpener = () => MessagePort | null;

const READ_TIMEOUT_MS = 250;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

function defaultPortOpener(): MessagePort | null {
  if (typeof window === "undefined" || typeof MessageChannel === "undefined")
    return null;
  const channel = new MessageChannel();
  channel.port1.start();
  window.postMessage({ kind: SHM_INIT }, "*", [channel.port2]);
  return channel.port1;
}

export function createShmClient(
  openPort: ShmPortOpener = defaultPortOpener,
  /** Monotonic clock (ms) — injectable so the windowed retention decay is
   *  deterministically testable; defaults to the module `now()`. */
  clock: () => number = now,
): ShmClient {
  const createdAt = Date.now();
  // Free-list of recyclable buffers, bucketed by byte length (C-15). Instead of
  // a fixed cap, each size's free-list is bounded by that size's own high-water
  // mark of concurrently-OUTSTANDING buffers (checked out, not yet recycled) —
  // i.e. the live working set. N same-resolution previews hold ~2N same-size
  // buffers (1 transferred to the preload mid-read + 1 displayed), so the pool
  // auto-grows to retain exactly that and steady state never re-allocates. The
  // old fixed `MAX_POOLED_PER_SIZE = 3` overflowed at N≥2 → a fresh multi-MB
  // ArrayBuffer per frame → major GC → the manage-cameras ~1–2 s freeze.
  //
  // value-sweep-2026-07-11 (`frame-ref-dispose-strands-pool-buffer`): the cap is
  // a WINDOWED max, not peak-EVER. A one-off spike (e.g. a transient burst of
  // previews, or a since-fixed leak) used to pin the retention cap forever, so
  // the pool never released those buffers back. Tracking the max over a trailing
  // couple of windows lets the cap DECAY once the working set shrinks, while a
  // steady stream keeps its cap (the peak recurs every window) and never
  // re-allocates.
  const RETENTION_WINDOW_MS = 5_000;
  interface SizeBucket {
    free: ArrayBuffer[];
    /** Buffers of this size currently checked out (not yet recycled). */
    outstanding: number;
    /** Max `outstanding` within the CURRENT trailing window. */
    windowPeak: number;
    /** Max `outstanding` within the PREVIOUS window (so the effective cap is a
     *  sliding max over [1, 2) windows — it never drops below a peak seen in the
     *  last `RETENTION_WINDOW_MS`, then decays). */
    prevWindowPeak: number;
    /** Start (`now()`) of the current window. */
    windowStart: number;
  }
  const pools = new Map<number, SizeBucket>();

  function bucketFor(bytes: number): SizeBucket {
    let b = pools.get(bytes);
    if (!b) {
      b = { free: [], outstanding: 0, windowPeak: 0, prevWindowPeak: 0, windowStart: clock() };
      pools.set(bytes, b);
    }
    return b;
  }

  /** The free-list retention cap: the sliding-window max of `outstanding`.
   *  Rotates the window lazily (on access) — after a full idle window the
   *  previous peak ages out and the cap decays toward the live working set. */
  function retentionCap(b: SizeBucket): number {
    const elapsed = clock() - b.windowStart;
    if (elapsed >= RETENTION_WINDOW_MS) {
      // >= 2 full windows idle → even the previous peak is stale; decay to live.
      b.prevWindowPeak = elapsed >= 2 * RETENTION_WINDOW_MS ? 0 : b.windowPeak;
      b.windowPeak = b.outstanding;
      b.windowStart = clock();
    }
    return Math.max(b.windowPeak, b.prevWindowPeak);
  }

  /** Drop the free-list of any size that is fully idle (no outstanding, no
   *  in-flight) once a DIFFERENT size becomes active — a resolution/format
   *  switch stops using the old size, so its retained buffers must not linger.
   *  Done at checkout (not recycle): a same-size release→reacquire keeps
   *  `outstanding` transiently 0 but must still reuse (the C-P2 pinned tests),
   *  so idle same-size buckets are preserved; only a switch to another size
   *  evicts the old one. */
  function evictIdleSizesExcept(keep: number): void {
    for (const [size, b] of pools)
      if (size !== keep && b.outstanding === 0) pools.delete(size);
  }
  const pending = new Map<
    number,
    {
      resolve(payload: FramePayload | null): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
      startedAt: number;
    }
  >();
  // Pipe reads (C-17) share the port + pool but track their own pending set
  // (a different resolve shape than the SHM_READ path).
  const pipePending = new Map<
    number,
    {
      resolve(r: PipeReadFrame | "closed" | null): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  // FIFO pipe reads (Phase 0) share the port + pool but resolve a wider outcome
  // (frame / notyet / gone+oldestSeq / closed), so they track their own pending.
  const pipeSeqPending = new Map<
    number,
    {
      resolve(r: PipeSeqReadResult): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const counts = {
    reads: 0,
    nulls: 0,
    timeouts: 0,
    errors: 0,
    allocations: 0,
    poolHits: 0,
    inFlight: 0,
  };
  // Round-trip latency accumulator (mean derived from sum/count on read).
  let latSum = 0;
  let latCount = 0;
  let latMax = 0;

  function recordLatency(startedAt: number): void {
    const dt = clock() - startedAt;
    latSum += dt;
    latCount++;
    if (dt > latMax) latMax = dt;
  }
  let seq = 0;
  let port: MessagePort | null = null;
  let disposed = false;

  function recycle(buffer: ArrayBuffer): void {
    const b = bucketFor(buffer.byteLength);
    b.outstanding = Math.max(0, b.outstanding - 1);
    // Retain up to the windowed working-set cap. A steady stream keeps its cap
    // (the peak recurs each window), so this never drops a buffer the steady
    // state needs; once the working set shrinks past a window, the cap decays
    // and surplus buffers are let go (the retention leak this fixes).
    if (b.free.length < retentionCap(b)) b.free.push(buffer);
  }

  function checkout(bytes: number): ArrayBuffer {
    evictIdleSizesExcept(bytes);
    const b = bucketFor(bytes);
    b.outstanding++;
    retentionCap(b); // rotate the window if it elapsed before recording the peak
    if (b.outstanding > b.windowPeak) b.windowPeak = b.outstanding;
    const pooled = b.free.pop();
    if (pooled) {
      counts.poolHits++;
      return pooled;
    }
    counts.allocations++;
    return new ArrayBuffer(bytes);
  }

  function onPipeDone(msg: PipeReadDone): void {
    const entry = pipePending.get(msg.id);
    if (!entry) {
      recycle(msg.buffer); // stale/late reply — reclaim the transferred buffer
      return;
    }
    clearTimeout(entry.timer);
    pipePending.delete(msg.id);
    if (msg.error) {
      counts.errors++;
      recycle(msg.buffer);
      entry.reject(new Error(msg.error));
      return;
    }
    if (msg.closed) {
      recycle(msg.buffer);
      entry.resolve("closed");
      return;
    }
    if (msg.seq === undefined) {
      counts.nulls++;
      recycle(msg.buffer); // no new frame — buffer came back unused
      entry.resolve(null);
      return;
    }
    counts.reads++;
    entry.resolve({
      data: msg.buffer,
      seq: msg.seq,
      tCapture: msg.tCapture,
      convertMs: msg.convertMs,
      gen: msg.gen,
      retries: msg.retries,
      width: msg.width,
      height: msg.height,
      originX: msg.originX,
      originY: msg.originY,
      bytes: msg.bytes,
    });
  }

  function onPipeSeqDone(msg: PipeReadSeqDone): void {
    const entry = pipeSeqPending.get(msg.id);
    if (!entry) {
      recycle(msg.buffer); // stale/late reply — reclaim the transferred buffer
      return;
    }
    clearTimeout(entry.timer);
    pipeSeqPending.delete(msg.id);
    if (msg.error) {
      counts.errors++;
      recycle(msg.buffer);
      entry.reject(new Error(msg.error));
      return;
    }
    if (msg.closed) {
      recycle(msg.buffer);
      entry.resolve("closed");
      return;
    }
    if (msg.gone) {
      recycle(msg.buffer); // slot recycled — buffer unused
      entry.resolve({ gone: true, oldestSeq: msg.oldestSeq ?? 0n });
      return;
    }
    if (msg.notYet || msg.seq === undefined) {
      counts.nulls++;
      recycle(msg.buffer); // not published yet (or torn) — buffer unused
      entry.resolve("notyet");
      return;
    }
    counts.reads++;
    entry.resolve({
      data: msg.buffer,
      seq: msg.seq,
      tCapture: msg.tCapture,
      convertMs: msg.convertMs,
      gen: msg.gen,
      retries: msg.retries,
      width: msg.width,
      height: msg.height,
      originX: msg.originX,
      originY: msg.originY,
      bytes: msg.bytes,
    });
  }

  function onDone(data: unknown): void {
    const msg = data as
      | (ShmReadDone | PipeReadDone | PipeReadSeqDone)
      | undefined;
    if (msg?.kind === PIPE_READ_SEQ_DONE) return onPipeSeqDone(msg);
    if (msg?.kind === PIPE_READ_DONE) return onPipeDone(msg);
    if (msg?.kind !== SHM_READ_DONE) return;
    const entry = pending.get(msg.id);
    // No matching pending entry: this is a STALE/late reply (the read already
    // timed out, or we were disposed). Reclaim the transferred buffer so it
    // isn't leaked.
    if (!entry) {
      if (msg.buffer) recycle(msg.buffer);
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    counts.inFlight = pending.size;
    // A reply arrived (any outcome but timeout) — a completed round-trip.
    recordLatency(entry.startedAt);
    if (msg.error) {
      counts.errors++;
      if (msg.buffer) recycle(msg.buffer);
      entry.reject(new Error(msg.error));
      return;
    }
    if (!msg.payload) {
      counts.nulls++;
      // Null result: the buffer came back unused, pool it immediately.
      if (msg.buffer) recycle(msg.buffer);
      entry.resolve(null);
      return;
    }
    // Success: the buffer now backs `payload.data`; the caller returns it via
    // release() once the frame is displaced.
    counts.reads++;
    entry.resolve(msg.payload);
  }

  function ensurePort(): MessagePort | null {
    if (port || disposed) return port;
    port = openPort();
    if (port) port.onmessage = (event: MessageEvent) => onDone(event.data);
    return port;
  }

  function transferRead(payload: FramePayload): Promise<FramePayload | null> {
    const p = ensurePort();
    if (!p)
      return Promise.reject(
        new Error("SHM MessagePort transfer pool unavailable"),
      );
    const id = ++seq;
    const buffer = checkout(frameByteLength(payload));
    const startedAt = clock();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        counts.inFlight = pending.size;
        counts.timeouts++;
        // The buffer is still in the preload's hands; the STALE path reclaims
        // it when the late read-done arrives.
        reject(new Error("SHM transfer read timed out"));
      }, READ_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, startedAt });
      counts.inFlight = pending.size;
      const req: ShmReadRequest = { kind: SHM_READ, id, payload, buffer };
      p.postMessage(req, [buffer]);
    });
  }

  return {
    async read(payload) {
      if (payload.data || !payload.shm) return payload;
      if (typeof window === "undefined") return null;
      try {
        return await transferRead(payload);
      } catch (error) {
        console.error("[shm] transfer-pool read failed", error);
        return null;
      }
    },
    release(payload) {
      if (payload?.shm && payload.data) recycle(payload.data);
    },
    readPipe(shmName, lastSeq, bytes) {
      const p = ensurePort();
      if (!p)
        return Promise.reject(
          new Error("SHM MessagePort transfer pool unavailable"),
        );
      const id = ++seq;
      const buffer = checkout(bytes);
      return new Promise<PipeReadFrame | "closed" | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          pipePending.delete(id);
          counts.timeouts++;
          reject(new Error("pipe read timed out"));
        }, READ_TIMEOUT_MS);
        pipePending.set(id, { resolve, reject, timer });
        const req: PipeReadRequest = {
          kind: PIPE_READ,
          id,
          shmName,
          lastSeq,
          buffer,
        };
        p.postMessage(req, [buffer]);
      });
    },
    readPipeSeq(shmName, wantSeq, bytes) {
      const p = ensurePort();
      if (!p)
        return Promise.reject(
          new Error("SHM MessagePort transfer pool unavailable"),
        );
      const id = ++seq;
      const buffer = checkout(bytes);
      return new Promise<PipeSeqReadResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pipeSeqPending.delete(id);
          counts.timeouts++;
          reject(new Error("pipe seq read timed out"));
        }, READ_TIMEOUT_MS);
        pipeSeqPending.set(id, { resolve, reject, timer });
        const req: PipeReadSeqRequest = {
          kind: PIPE_READ_SEQ,
          id,
          shmName,
          wantSeq,
          buffer,
        };
        p.postMessage(req, [buffer]);
      });
    },
    releaseBuffer(buffer) {
      if (buffer) recycle(buffer);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("SHM transfer pool disposed"));
      }
      pending.clear();
      for (const entry of pipePending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("SHM transfer pool disposed"));
      }
      pipePending.clear();
      for (const entry of pipeSeqPending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("SHM transfer pool disposed"));
      }
      pipeSeqPending.clear();
      counts.inFlight = 0;
      pools.clear();
      port?.close();
      port = null;
    },
    stats() {
      const window = snapshotWindow(createdAt);
      const drops = counts.timeouts + counts.errors;
      return {
        ...counts,
        window,
        rates: {
          reads: counterRate(counts.reads, window),
          nulls: counterRate(counts.nulls, window),
          timeouts: counterRate(counts.timeouts, window),
          errors: counterRate(counts.errors, window),
          allocations: counterRate(counts.allocations, window),
          poolHits: counterRate(counts.poolHits, window),
        },
        workload: {
          name: "renderer:shmReads",
          window,
          utilization: 0,
          busyMs: 0,
          inputs: {
            requests: counterRate(
              counts.reads + counts.nulls + counts.timeouts + counts.errors,
              window,
            ),
          },
          outputs: {
            reads: counterRate(counts.reads, window),
            nulls: counterRate(counts.nulls, window),
            allocations: counterRate(counts.allocations, window),
            poolHits: counterRate(counts.poolHits, window),
          },
          drops: {
            total: drops,
            ratePerSec: ratePerSec(drops, window),
            byReason: {
              timeout: counts.timeouts,
              error: counts.errors,
            },
          },
        },
        latencyMs: {
          count: latCount,
          mean: latCount ? latSum / latCount : 0,
          max: latMax,
        },
      };
    },
  };
}
