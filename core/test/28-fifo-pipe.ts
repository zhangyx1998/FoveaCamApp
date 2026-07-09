// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// capture-recorder-nodes Phase 0: FIFO pipe READ mode (`reader.readSeqInto`).
// The writer path is unchanged — FIFO is a CONSUMER read discipline over the
// existing seqlock ring: seq N lives in slot N % slotCount (ShmWrite's
// round-robin invariant), so a consumer drives an ORDERED, lossless-within-a-
// ring stream by reading `lastDelivered + 1` each step. NO hardware — a
// synthetic publisher (`Pipe.offerFrame`, one frame per call on the caller's
// thread, whole frame filled with `seq & 0xff`) gives byte-exact, precisely
// paced control. Proves:
//   1. NotYet before the first offer + for any seq past latest.
//   2. Ordered lossless delivery of seq 1..DEPTH through a full ring while the
//      consumer lags right up to the ring depth (a slow consumer, no drops).
//   3. Gone once the consumer lags PAST a full ring: the exact oldest-live jump
//      target + the exact drop count (a full ring's worth), then lossless
//      delivery resumes from the jump.
//   4. A concurrent LATEST-WINS reader (`readInto`) of the SAME pipe is
//      unaffected by the FIFO reader.
//   5. Closed once the publisher closes and nothing newer will arrive.
//   6. Natural exit 0 (orderly disconnect/close/drop).
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/28-fifo-pipe.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Pipe, __origin__ } from "core";

type ReaderHandle = object;
type Ok = {
  seq: bigint;
  gen: number;
  retries: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  meta: { tCapture: number };
};
type NotYet = { notYet: true };
type Gone = { gone: true; oldestSeq: bigint };
type Closed = { closed: true };
type SeqResult = Ok | NotYet | Gone | Closed | null;
type ReaderAddon = {
  open(seg: string): ReaderHandle;
  readInto(h: ReaderHandle, dest: ArrayBuffer, lastSeq: bigint):
    | { seq: bigint; width: number; height: number }
    | { closed: true }
    | null;
  readSeqInto(h: ReaderHandle, dest: ArrayBuffer, wantSeq: bigint): SeqResult;
  close(h: ReaderHandle): void;
};

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(
  join(dirname(__origin__), `${prefix}-shm-reader.node`),
) as ReaderAddon;

const P = Pipe as unknown as {
  advertise(spec: Record<string, unknown>): number;
  connect(id: string): { shmName: string };
  disconnect(id: string): number;
  close(id: string): void;
  drop(id: string): void;
  offerFrame(id: string, w: number, h: number, byte: number): void;
};

const show = (r: SeqResult): string =>
  JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const isOk = (r: SeqResult): r is Ok =>
  typeof r === "object" && r !== null && "seq" in r;
const isNotYet = (r: SeqResult): r is NotYet =>
  typeof r === "object" && r !== null && (r as NotYet).notYet === true;
const isGone = (r: SeqResult): r is Gone =>
  typeof r === "object" && r !== null && (r as Gone).gone === true;

// --- one small deep-ring pipe -------------------------------------------------
const ID = "test/fifo/raw";
const W = 4, H = 4, CH = 1;
const BYTES = W * H * CH; // 16
const DEPTH = 16;
P.advertise({
  id: ID, pixelFormat: "Mono8", dtype: "U8", width: W, height: H,
  channels: CH, stride: W * CH, bytesPerFrame: BYTES, ringDepth: DEPTH,
});
const { shmName } = P.connect(ID); // refcount>0 so offers actually write
const rh = reader.open(shmName);
const dst = new ArrayBuffer(BYTES);

// The FIFO consumer's ordered read: request `want`, retry torn reads.
const readSeq = (want: number): SeqResult =>
  reader.readSeqInto(rh, dst, BigInt(want));
const contentByte = () => new Uint8Array(dst)[0];
const offer = (seq: number) => P.offerFrame(ID, W, H, seq & 0xff);

// --- 1: NotYet before anything is published ----------------------------------
{
  const r = readSeq(1);
  assert(isNotYet(r), "seq 1 is NotYet before the first offer");
  console.log("28-fifo-pipe: NotYet before first offer OK.");
}

// --- 2: ordered lossless delivery of a full ring (slow consumer, no drops) ----
{
  for (let i = 1; i <= DEPTH; i++) offer(i); // fill the ring exactly (seq 1..16)
  // Consumer lagged the full ring depth, then drains in order — every frame Ok.
  for (let want = 1; want <= DEPTH; want++) {
    let r = readSeq(want);
    // (torn reads return null → retry the same want; none expected here)
    while (r === null) r = readSeq(want);
    assert(isOk(r), `seq ${want} delivered (Ok), got ${show(r)}`);
    assert.equal(Number(r.seq), want, `readSeqInto returns the requested seq`);
    assert.equal(r.width, W, "active width");
    assert.equal(r.height, H, "active height");
    assert.equal(contentByte(), want & 0xff, `frame ${want} content == seq&0xff`);
  }
  // seq DEPTH+1 not offered yet → NotYet.
  assert(isNotYet(readSeq(DEPTH + 1)), "seq past latest is NotYet");
  console.log(`28-fifo-pipe: ordered lossless delivery through a depth-${DEPTH} ring OK.`);
}

// --- 4 (interleaved): a concurrent latest-wins reader is unaffected -----------
const rhLatest = reader.open(shmName);
const dstLatest = new ArrayBuffer(BYTES);
{
  const r = reader.readInto(rhLatest, dstLatest, 0n);
  assert(r && "seq" in r, "latest-wins reader returns a frame");
  assert.equal(Number((r as { seq: bigint }).seq), DEPTH, "latest-wins sees seq DEPTH");
  assert.equal(new Uint8Array(dstLatest)[0], DEPTH & 0xff, "latest content == newest");
}

// --- 3: Gone once the consumer lags PAST a full ring -------------------------
{
  // Consumer is at want = DEPTH+1 (=17). Race the writer 2 full rings ahead:
  // offer seq 17..48. latest = 48, live window = [48-16+1, 48] = [33, 48], so
  // seq 17 (and 18..32) have been recycled — exactly DEPTH drops.
  for (let i = DEPTH + 1; i <= 48; i++) offer(i);
  const want = DEPTH + 1; // 17
  const r = readSeq(want);
  assert(isGone(r), `seq ${want} is Gone (lagged past the ring), got ${show(r)}`);
  assert.equal(Number(r.oldestSeq), 33, "Gone reports the oldest still-live seq");
  const drops = Number(r.oldestSeq) - want;
  assert.equal(drops, DEPTH, `drop count == a full ring (${DEPTH})`);

  // Consumer JUMPS to oldestSeq and resumes lossless, in order, from there.
  for (let w = Number(r.oldestSeq); w <= 48; w++) {
    let rr = readSeq(w);
    while (rr === null) rr = readSeq(w);
    assert(isOk(rr), `resumed seq ${w} Ok after jump`);
    assert.equal(Number(rr.seq), w, "resumed in order");
    assert.equal(contentByte(), w & 0xff, `resumed frame ${w} content`);
  }
  console.log("28-fifo-pipe: Gone jump + exact drop accounting + lossless resume OK.");
}

// --- 4b: latest-wins reader still tracks the newest frame after all that ------
{
  const r = reader.readInto(rhLatest, dstLatest, 0n);
  // 0n lastSeq forces a fresh read of whatever latest is (48).
  assert(r && "seq" in r, "latest-wins reader still returns frames");
  assert.equal(Number((r as { seq: bigint }).seq), 48, "latest-wins sees the newest seq 48");
  console.log("28-fifo-pipe: concurrent latest-wins reader unaffected by FIFO reads OK.");
}

// --- 5: Closed after the publisher closes ------------------------------------
{
  P.close(ID);
  // Invariant: a frame published BEFORE close must still be readable — CLOSED is
  // an explicit end-of-stream signal, never a mask over already-delivered seqs.
  let last = readSeq(48); // the final published frame, still in the live ring
  while (last === null) last = readSeq(48);
  assert(isOk(last), `final pre-close frame (48) still readable, got ${show(last)}`);
  assert.equal(Number(last.seq), 48, "closed pipe still serves its last frame");
  assert.equal(contentByte(), 48 & 0xff, "final frame content intact after close");

  const r = readSeq(49); // past latest (48) + pipe now CLOSED
  assert(r !== null && "closed" in r, `seq past latest on a closed pipe is Closed, got ${show(r)}`);
  console.log("28-fifo-pipe: last frame readable after close + Closed past latest OK.");
}

// --- 6: orderly teardown → natural exit --------------------------------------
reader.close(rh);
reader.close(rhLatest);
P.disconnect(ID);
P.drop(ID);
console.log("28-fifo-pipe: orderly teardown complete — exiting naturally.");
