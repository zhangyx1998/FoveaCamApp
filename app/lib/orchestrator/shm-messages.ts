// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer-safe wire contract for the SHM transfer MessagePort. Both the
// renderer pool and the unsandboxed preload import this file so buffer
// ownership fields cannot drift between the two ends.

import type { FramePayload } from "./protocol.js";

export const SHM_READ = "fovea:shm:read";
export const SHM_READ_DONE = "fovea:shm:read-done";
export const SHM_INIT = "fovea:shm:init";

export type ShmReadRequest = {
  kind: typeof SHM_READ;
  id: number;
  payload: FramePayload;
  buffer: ArrayBuffer;
};

export type ShmReadDone = {
  kind: typeof SHM_READ_DONE;
  id: number;
  payload: FramePayload | null;
  buffer?: ArrayBuffer;
  error?: string;
};

// WS1 pipe transport (C-17). A connected pipe consumer reads by segment NAME
// with a consumer-tracked `lastSeq` (there is no per-frame descriptor, unlike
// the SHM_READ path). One-time connect handshake, then these ride the same
// preload MessagePort + C-15 buffer pool.
export const PIPE_READ = "fovea:pipe:read";
export const PIPE_READ_DONE = "fovea:pipe:read-done";

export type PipeReadRequest = {
  kind: typeof PIPE_READ;
  id: number;
  shmName: string;
  lastSeq: bigint;
  buffer: ArrayBuffer;
};

export type PipeReadDone = {
  kind: typeof PIPE_READ_DONE;
  id: number;
  /** Always transferred back so the pool can recycle it. On a fresh frame it
   *  now backs the pixels; otherwise it came back unused. */
  buffer: ArrayBuffer;
  /** Present on a fresh frame (stable seq). Absent = no new frame this poll. */
  seq?: bigint;
  tCapture?: number;
  /** Producer-side convert cost (ms) for this frame, from the reader's
   *  `FrameMeta` (A-26 Fix D) — lets the StreamView inspector show `convertMs`
   *  on pipe streams, not just the tracking-multi wide view. */
  convertMs?: number;
  /** Seqlock generation + retry count from the reader's `readInto` result
   *  (A-26 Fix D) — surfaces the SHM health line in the inspector for pipes. */
  gen?: number;
  retries?: number;
  /** Active frame size for this read (C-20 dynamic resize) — the frame occupies
   *  `width*height*channels` bytes at the head of the (max-sized) buffer. */
  width?: number;
  height?: number;
  /** Frame-bound crop origin in the parent stream (v4, fovea pipes). */
  originX?: number;
  originY?: number;
  /** Actual payload byte length the reader copied (ring v5 `payloadBytes`) —
   *  present only for a variable-length blob (compression pipes); absent on a
   *  dim-derived frame. */
  bytes?: number;
  /** True when the publisher has set state=CLOSED — the consumer should unmap. */
  closed?: boolean;
  error?: string;
};

// capture-recorder-nodes Phase 0: FIFO pipe read transport. The recorder/capture
// consumer reads a SPECIFIC frame (`wantSeq = lastDelivered + 1`) through the
// same preload MessagePort + C-15 buffer pool as PIPE_READ, but via the reader
// addon's `readSeqInto` (ordered, lossless-within-a-ring delivery). The DONE
// message classifies the FIFO outcome (frame / notYet / gone+oldestSeq /
// closed) so the consumer can drop-account a lagged ring. The latest-wins
// PIPE_READ path above is unchanged.
export const PIPE_READ_SEQ = "fovea:pipe:read-seq";
export const PIPE_READ_SEQ_DONE = "fovea:pipe:read-seq-done";

export type PipeReadSeqRequest = {
  kind: typeof PIPE_READ_SEQ;
  id: number;
  shmName: string;
  /** The exact stable seq to read (the consumer tracks `lastDelivered + 1`). */
  wantSeq: bigint;
  buffer: ArrayBuffer;
};

export type PipeReadSeqDone = {
  kind: typeof PIPE_READ_SEQ_DONE;
  id: number;
  /** Always transferred back for pool recycling (backs pixels only on a frame). */
  buffer: ArrayBuffer;
  /** Present when `wantSeq` was delivered (== `wantSeq`). */
  seq?: bigint;
  tCapture?: number;
  convertMs?: number;
  gen?: number;
  retries?: number;
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
  /** Actual payload byte length the reader copied (ring v5 `payloadBytes`) —
   *  present only for a variable-length blob (compression pipes); absent on a
   *  dim-derived frame (the consumer falls back to dims). */
  bytes?: number;
  /** `wantSeq` not published yet — the consumer short-polls/backs off + retries. */
  notYet?: boolean;
  /** `wantSeq`'s ring slot was recycled (consumer lagged a full ring). Present
   *  together with `oldestSeq` = the oldest still-live seq to JUMP to; the
   *  consumer accounts `wantSeq..oldestSeq-1` as drops. */
  gone?: boolean;
  oldestSeq?: bigint;
  /** Publisher CLOSED and nothing newer will arrive — the consumer stops. */
  closed?: boolean;
  error?: string;
};
