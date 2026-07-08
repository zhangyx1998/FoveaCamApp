// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer-side pipe consumer loop (C-17, WS1 1c-PREP). Given a `PipeHandle`
// (from `connectPipe`), it polls the segment through the preload reader addon
// (`io.readPipe` — reuses the C-15 buffer pool), tracks `lastSeq` itself, and
// emits `FramePayload`s to a display sink. On the explicit CLOSED signal it
// stops and releases its buffers. Nothing per-frame crosses the Channel — the
// JS handshake happened once at connect.
//
// Vue-free (the display ref/binding lives in `client.ts`); `io` is injected so
// tests drive it with a scripted reader.

import type { FrameMeta, FramePayload } from "./protocol.js";
import type { PipeHandle } from "./pipe-contract.js";
import type { PipeReadFrame } from "./shm-client.js";

export interface PipeReaderIO {
  readPipe(
    shmName: string,
    lastSeq: bigint,
    bytes: number,
  ): Promise<PipeReadFrame | "closed" | null>;
  releaseBuffer(buffer: ArrayBuffer | null | undefined): void;
}

/** Emits the latest frame (or `null` when the pipe closes) to the display. */
export type PipeFrameSink = (frame: FramePayload | null) => void;

export interface PipeConsumer {
  /** Run one read cycle (exposed for deterministic tests + manual pacing). */
  poll(): Promise<void>;
  /** Begin polling on the animation frame (renderer only). Idempotent. */
  start(): void;
  /** Stop polling and release the displayed buffer. Idempotent. */
  stop(): void;
  readonly closed: boolean;
}

const raf =
  typeof requestAnimationFrame !== "undefined"
    ? requestAnimationFrame
    : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
const cancelRaf =
  typeof cancelAnimationFrame !== "undefined"
    ? cancelAnimationFrame
    : (id: number) => clearTimeout(id);

export function createPipeConsumer(
  handle: PipeHandle,
  io: PipeReaderIO,
  sink: PipeFrameSink,
): PipeConsumer {
  const { shmName, spec } = handle;
  let lastSeq = 0n;
  let displayed: ArrayBuffer | null = null;
  let closed = false;
  let running = false;
  let handle_ = 0;

  async function poll(): Promise<void> {
    if (closed) return;
    let r: PipeReadFrame | "closed" | null;
    try {
      r = await io.readPipe(shmName, lastSeq, spec.bytesPerFrame);
    } catch {
      return; // transport hiccup (timeout/error) — retry next tick
    }
    if (r === "closed") {
      closed = true;
      sink(null); // clear the display; caller disconnects
      return;
    }
    if (!r) return; // no newer frame this poll
    lastSeq = r.seq;
    // Use the frame's ACTIVE size (C-20 dynamic resize) — a fovea varies its
    // w/h inside a max ring; fall back to the spec nominal for fixed pipes.
    const width = r.width ?? spec.width;
    const height = r.height ?? spec.height;
    // A-26 Fix D: carry the producer convert cost + seqlock health the reader
    // computed so the StreamView inspector shows the same metrics on pipe
    // streams (previously only tracking-multi's wide SHM view had them).
    const meta: FrameMeta = { tCapture: r.tCapture, seq: Number(r.seq) };
    if (r.convertMs !== undefined) meta.convertMs = r.convertMs;
    const payload: FramePayload = {
      data: r.data,
      shape: [height, width],
      channels: spec.channels,
      meta,
    };
    // `.shm` lights the inspector's SHM health line (gen/retries) + the shared
    // transfer-pool counters, which the pipe path feeds too. `seg` is the pipe
    // segment name; only set once the transport actually reports a generation.
    if (r.gen !== undefined) {
      payload.shm = { seg: shmName, gen: r.gen, seq: r.seq, retries: r.retries };
    }
    // The displaced frame's buffer returns to the pool (steady state: zero
    // allocation — the C-15 win, now on the pipe path).
    if (displayed) io.releaseBuffer(displayed);
    displayed = r.data;
    sink(payload);
  }

  function loop(): void {
    if (!running) return;
    void poll().finally(() => {
      if (running && !closed) handle_ = raf(loop);
    });
  }

  return {
    get closed() {
      return closed;
    },
    poll,
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
      if (handle_) cancelRaf(handle_);
      handle_ = 0;
      if (displayed) {
        io.releaseBuffer(displayed);
        displayed = null;
      }
    },
  };
}
