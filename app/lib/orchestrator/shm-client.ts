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

/** Message the pool sends the preload to request a transferred read. */
type ReadRequest = {
  kind: "fovea:shm:read";
  id: number;
  payload: FramePayload;
  buffer: ArrayBuffer;
};

/** Reply from the preload; `buffer` is transferred back so it can be pooled. */
type ReadDone = {
  kind: "fovea:shm:read-done";
  id: number;
  payload: FramePayload | null;
  buffer?: ArrayBuffer;
  error?: string;
};

/** Round-trip latency summary (ms) — same `{count, mean, max}` shape as the
 *  Channel frame-timing stats, so the OSD/profiler render it uniformly. */
export type ShmLatencyStats = {
  count: number;
  mean: number;
  max: number;
};

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
  /** Round-trip latency of completed reads (reply received, not timed out). */
  latencyMs: ShmLatencyStats;
};

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

const MAX_POOLED_PER_SIZE = 3;
const READ_TIMEOUT_MS = 250;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

function defaultPortOpener(): MessagePort | null {
  if (typeof window === "undefined" || typeof MessageChannel === "undefined")
    return null;
  const channel = new MessageChannel();
  channel.port1.start();
  window.postMessage({ kind: "fovea:shm:init" }, "*", [channel.port2]);
  return channel.port1;
}

export function createShmClient(
  openPort: ShmPortOpener = defaultPortOpener,
): ShmClient {
  // Free-list of recyclable buffers, bucketed by byte length. Bounded per size
  // so a burst of odd sizes can't grow it without limit.
  const pools = new Map<number, ArrayBuffer[]>();
  const pending = new Map<
    number,
    {
      resolve(payload: FramePayload | null): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
      startedAt: number;
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
    const dt = now() - startedAt;
    latSum += dt;
    latCount++;
    if (dt > latMax) latMax = dt;
  }
  let seq = 0;
  let port: MessagePort | null = null;
  let disposed = false;

  function recycle(buffer: ArrayBuffer): void {
    const pool = pools.get(buffer.byteLength) ?? [];
    if (pool.length < MAX_POOLED_PER_SIZE) pool.push(buffer);
    pools.set(buffer.byteLength, pool);
  }

  function checkout(bytes: number): ArrayBuffer {
    const pooled = pools.get(bytes)?.pop();
    if (pooled) {
      counts.poolHits++;
      return pooled;
    }
    counts.allocations++;
    return new ArrayBuffer(bytes);
  }

  function onDone(data: unknown): void {
    const msg = data as ReadDone | undefined;
    if (msg?.kind !== "fovea:shm:read-done") return;
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
    const startedAt = now();
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
      const req: ReadRequest = { kind: "fovea:shm:read", id, payload, buffer };
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
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("SHM transfer pool disposed"));
      }
      pending.clear();
      counts.inFlight = 0;
      pools.clear();
      port?.close();
      port = null;
    },
    stats() {
      return {
        ...counts,
        latencyMs: {
          count: latCount,
          mean: latCount ? latSum / latCount : 0,
          max: latMax,
        },
      };
    },
  };
}
