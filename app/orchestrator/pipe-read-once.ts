// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// One-shot SHM pipe read (C-23, ruled Q2): manual-control's capture wants "the
// NEXT center frame" while a pass is running — an on-demand, user-initiated
// read, NOT a per-frame loop, so a single memcpy on the orchestrator thread is
// fine here (the per-frame path stays in the vision worker). Skips the frame
// already in the ring at call time (`latestSeq` first), then polls with a short
// backoff until a NEWER frame lands — a steer-then-capture pass must not grab a
// pre-steer frame.
//
// The caller is responsible for the pipe being CONNECTED (refcount → C-21 gate
// → producer running) for the duration; capture rides the session's existing
// worker connection.

import { createRequire } from "node:module";
import { makeMat } from "@lib/mat";
import type { Mat } from "core/Vision";
import { readerAddonPath } from "./vision-worker-host.js";

const requireHere = createRequire(import.meta.url);

interface ReaderAddon {
  open(name: string): unknown;
  latestSeq(handle: unknown): bigint;
  readInto(
    handle: unknown,
    dst: ArrayBufferView,
    lastSeq: bigint,
  ):
    | null
    | { closed: true }
    | { seq: bigint; width: number; height: number; bytes?: number };
  /** FIFO read of a SPECIFIC frame (capture-recorder-nodes Phase 0). The
   *  recorder/capture worker reads `wantSeq = lastDelivered + 1` in order:
   *  a frame (`seq === wantSeq`), `{ notYet }` (not published yet — retry),
   *  `{ gone, oldestSeq }` (slot recycled — jump + drop-account), `{ closed }`,
   *  or `null` (torn read — retry). */
  readSeqInto(
    handle: unknown,
    dst: ArrayBufferView,
    wantSeq: bigint,
  ):
    | null
    | { closed: true }
    | { notYet: true }
    | { gone: true; oldestSeq: bigint }
    | { seq: bigint; width: number; height: number; bytes?: number };
  close(handle: unknown): void;
}

let addon: ReaderAddon | null = null;
const loadAddon = (): ReaderAddon =>
  (addon ??= requireHere(readerAddonPath()) as ReaderAddon);

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BACKOFF_MS = 2;

/**
 * Read the next frame (strictly newer than the ring's state at call time) from
 * an SHM pipe segment. Returns an independent BGRA Mat, or `null` on timeout /
 * pipe CLOSED. `maxBytes` sizes the read buffer (the pipe spec's
 * `maxBytes ?? bytesPerFrame`); `channels` shapes the returned Mat.
 */
export async function readNextPipeFrame(
  shmName: string,
  maxBytes: number,
  channels: number,
  { timeoutMs = 2000 }: { timeoutMs?: number } = {},
): Promise<Mat<Uint8Array> | null> {
  const io = loadAddon();
  const handle = io.open(shmName);
  try {
    const buffer = new Uint8Array(maxBytes);
    let lastSeq = io.latestSeq(handle); // skip whatever is already in the ring
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = io.readInto(handle, buffer, lastSeq);
      if (r !== null) {
        if ("closed" in r) return null;
        const len = r.width * r.height * channels;
        // Independent copy — `buffer` is local, but slice to the active size.
        return makeMat(buffer.slice(0, len), [r.height, r.width], channels);
      }
      if (Date.now() >= deadline) return null;
      await delay(BACKOFF_MS); // lastSeq stays pinned to call time — only newer frames count
    }
  } finally {
    io.close(handle);
  }
}
