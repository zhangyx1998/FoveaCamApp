// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// multi-fovea-recording ruling 10: RING LAYOUT v5 — per-frame `payloadBytes`.
// A slot can now carry a VARIABLE-LENGTH payload (compression bricks) shorter
// than the slot capacity; the reader copies EXACTLY that many bytes and surfaces
// the length to JS as `bytes`. NO hardware — the `Pipe.offerFrame` test hook
// publishes on the caller's thread (its optional 5th arg = payloadBytes → an
// opaque RAMP-filled blob). Proves:
//   1. An OPAQUE frame (payloadBytes < slot capacity) reads back EXACT length +
//      content, and okResult carries `bytes` == the published length. The frame
//      keeps its SOURCE identity (width/height) alongside the shorter blob.
//   2. A payloadBytes-0 frame is DIMS-derived and UNCHANGED — no `bytes` field,
//      width/height/content exactly as ring v4 (regression).
//   3. DestTooSmall is judged against the ACTUAL length: a dst sized to the blob
//      (< slot capacity) SUCCEEDS; a dst smaller than the blob THROWS. A dims-
//      derived frame still needs the full slot (dst < slotBytes THROWS).
//   4. Natural exit 0 (orderly disconnect/close/drop).
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/31-ring-v5-payload-bytes.ts

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
  bytes?: number; // v5: present ONLY when the slot records a nonzero payloadBytes
  meta: { tCapture: number };
};
type NotYet = { notYet: true };
type Closed = { closed: true };
type SeqResult = Ok | NotYet | Closed | null;
type ReaderAddon = {
  open(seg: string): ReaderHandle;
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
  // v5: the optional 5th arg publishes an OPAQUE blob of `payloadBytes` bytes,
  // filled with a RAMP `(byte + i) & 0xff`; omitted = a dims-derived frame.
  offerFrame(id: string, w: number, h: number, byte: number, payloadBytes?: number): void;
};

const isOk = (r: SeqResult): r is Ok =>
  typeof r === "object" && r !== null && "seq" in r;

// --- a pipe whose SLOT CAPACITY (maxBytes) far exceeds the nominal dims -------
const ID = "test/ring-v5/payload";
const W = 8, H = 8, CH = 1;
const DIMS_BYTES = W * H * CH; // 64
const SLOT_CAP = 1024;         // maxBytes: room for variable-length blobs
P.advertise({
  id: ID, pixelFormat: "Mono8", dtype: "U8", width: W, height: H,
  channels: CH, stride: W * CH, bytesPerFrame: DIMS_BYTES,
  maxWidth: W, maxHeight: H, maxBytes: SLOT_CAP, ringDepth: 8,
});
const { shmName } = P.connect(ID);
const rh = reader.open(shmName);

// Read seq `want` into a dst of `cap` bytes, retrying torn reads.
const readSeq = (want: number, dst: ArrayBuffer): SeqResult => {
  let r = reader.readSeqInto(rh, dst, BigInt(want));
  while (r === null) r = reader.readSeqInto(rh, dst, BigInt(want));
  return r;
};
const ramp = (seed: number, i: number): number => (seed + i) & 0xff;

// --- 1: opaque blob (payloadBytes < slot capacity) — exact length + content ---
{
  const LEN = 300, SEED = 30;
  P.offerFrame(ID, W, H, SEED, LEN); // seq 1: opaque RAMP blob
  const dst = new ArrayBuffer(SLOT_CAP);
  const r = readSeq(1, dst);
  assert(isOk(r), "seq 1 (opaque) delivered");
  assert.equal(Number(r.seq), 1, "seq 1");
  assert.equal(r.bytes, LEN, `okResult.bytes == published payloadBytes (${LEN})`);
  assert.equal(r.width, W, "source identity: width preserved");
  assert.equal(r.height, H, "source identity: height preserved");
  const u8 = new Uint8Array(dst);
  for (let i = 0; i < LEN; i++)
    assert.equal(u8[i], ramp(SEED, i), `opaque byte ${i} == ramp`);
  console.log(`31-ring-v5: opaque blob (${LEN}B < ${SLOT_CAP} slot) exact length + content OK.`);
}

// --- 2: payloadBytes-0 frame is DIMS-derived + UNCHANGED (regression) ---------
{
  const SEED = 77;
  P.offerFrame(ID, W, H, SEED); // seq 2: dims-derived (no payloadBytes)
  const dst = new ArrayBuffer(SLOT_CAP);
  const r = readSeq(2, dst);
  assert(isOk(r), "seq 2 (dims-derived) delivered");
  assert.equal(r.bytes, undefined, "no `bytes` field on a dims-derived frame");
  assert.equal(r.width, W, "width");
  assert.equal(r.height, H, "height");
  const u8 = new Uint8Array(dst);
  for (let i = 0; i < DIMS_BYTES; i++)
    assert.equal(u8[i], SEED, `dims-derived byte ${i} == uniform seed`);
  console.log("31-ring-v5: payloadBytes-0 frame dims-derived + unchanged OK.");
}

// --- 3: DestTooSmall judged against the ACTUAL length -------------------------
{
  const LEN = 200, SEED = 11;
  P.offerFrame(ID, W, H, SEED, LEN); // seq 3: opaque blob

  // 3a: a dst sized EXACTLY to the blob (< slot capacity) SUCCEEDS — the v5 win.
  const exact = new ArrayBuffer(LEN);
  const r = readSeq(3, exact);
  assert(isOk(r), "dst == payloadBytes (< slot capacity) succeeds");
  assert.equal(r.bytes, LEN, "exact-sized read reports the blob length");
  const u8 = new Uint8Array(exact);
  for (let i = 0; i < LEN; i++)
    assert.equal(u8[i], ramp(SEED, i), `exact-fit byte ${i} == ramp`);

  // 3b: a dst SMALLER than the blob THROWS (DestTooSmall against the blob length).
  const tooSmall = new ArrayBuffer(LEN - 1);
  assert.throws(
    () => reader.readSeqInto(rh, tooSmall, 3n),
    /smaller than SHM frame/,
    "dst < payloadBytes throws DestTooSmall",
  );

  // 3c: a DIMS-derived frame still needs the FULL slot (dst < slotBytes throws).
  P.offerFrame(ID, W, H, 5); // seq 4: dims-derived
  const half = new ArrayBuffer(SLOT_CAP - 1);
  assert.throws(
    () => reader.readSeqInto(rh, half, 4n),
    /smaller than SHM frame/,
    "dims-derived frame: dst < slotBytes still throws",
  );
  console.log("31-ring-v5: DestTooSmall judged against the actual length OK.");
}

// --- 4: orderly teardown → natural exit --------------------------------------
reader.close(rh);
P.disconnect(ID);
P.close(ID);
P.drop(ID);
console.log("31-ring-v5-payload-bytes: orderly teardown complete — exiting naturally.");
