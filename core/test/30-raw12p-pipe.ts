// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PACKED raw-12p camera pipes
// (`attachRaw12pPipe`). Unlike the raw pipe (test 29 — the UNPACKED 16-bit
// `frame->raw` container), this taps the ArvBuffer BEFORE Frame construction
// (`Arv::Stream::BufferTap`, fired inside `Stream::iterate()` before the 12p→16
// unpack and before the requeue) and publishes the VERBATIM wire payload. NO
// hardware (Aravis fake camera). Proves:
//   1. CONSUMER-GATED — attached but NOT connected → the tap is not registered
//      on the stream (zero frames ingested); connecting spins it up.
//   2. PACKED BYTE-LENGTH — each published frame's active geometry accounts for
//      exactly the advertised payload size (`width*height == bytesPerFrame`),
//      i.e. the tap copied the arv_buffer payload verbatim, not a re-shaped mat.
//   3. FIFO read END TO END — the recorder's exact consumption loop delivers an
//      ORDERED stream; deviceTimestamp is plumbed onto every frame.
//   4. detach STOPS publishing + idempotency + orderly teardown → natural exit.
//
// WIRE FORMAT EXERCISED: the Aravis fake camera negotiates Mono8 (512x512, a
// WHOLE-BYTE, NON-packed format), so `payloadSize == width*height`. The tap is
// format-AGNOSTIC (it copies arv_buffer's payload bytes verbatim regardless of
// packing), so this proves the plumbing; a GENUINE Bayer-12p wire capture
// (payloadSize == width*height*3/2) needs hardware (12p payload verbatim vs a
// reference wire capture).
//
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/30-raw12p-pipe.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Aravis, Pipe, __origin__, cleanup } from "core";

type ReaderHandle = object;
type Meta = { deviceTimestamp?: bigint; systemTimestamp?: bigint };
type Ok = { seq: bigint; width: number; height: number; meta: Meta };
type Gone = { gone: true; oldestSeq: bigint };
type NotYet = { notYet: true };
type Closed = { closed: true };
type SeqResult = Ok | Gone | NotYet | Closed | null;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isOk = (r: SeqResult): r is Ok =>
  typeof r === "object" && r !== null && "seq" in r;
const isGone = (r: SeqResult): r is Gone =>
  typeof r === "object" && r !== null && (r as Gone).gone === true;

const P = Pipe as unknown as {
  advertise(spec: Record<string, unknown>): number;
  connect(id: string): { shmName: string };
  disconnect(id: string): number;
  close(id: string): void;
  drop(id: string): void;
};
const A = Aravis as unknown as {
  enableFakeCamera(): void;
  attachRaw12pPipe(camera: unknown, pipeId: string): boolean;
  detachRaw12pPipe(pipeId: string): boolean;
  raw12pProbeAll(): Record<
    string,
    { name: string; inputs: { frame: { count: number } } }
  >;
  Camera: {
    list(): Promise<
      Array<{
        serial?: string;
        grab(t: number): Promise<{
          raw: { shape: number[]; channels?: number; BYTES_PER_ELEMENT: number };
          release?(): void;
        }>;
        release?(): void;
      }>
    >;
  };
};

// --- fake camera geometry (probe one frame) ----------------------------------
A.enableFakeCamera();
const cams = await A.Camera.list();
assert(cams.length > 0, "fake camera enumerated");
const camera = cams[0]!;
const probe = await camera.grab(2_000_000);
const [H, W] = probe.raw.shape as [number, number];
const CH = probe.raw.channels ?? (probe.raw.shape.length === 3 ? probe.raw.shape[2]! : 1);
const BPE = probe.raw.BYTES_PER_ELEMENT;
probe.release?.();
// For a WHOLE-BYTE wire format (the fake's Mono8) the packed payload equals the
// unpacked bytes. `bytesPerFrame` = the actual wire payload the tap will copy;
// `rowBytes` = packed bytes per row. (For genuine 12p: bytesPerFrame = W*H*3/2,
// rowBytes = W*3/2 — sourced from the ArvBuffer payload size at the rig.)
const bytesPerFrame = W * H * CH * BPE;
const rowBytes = W * CH * BPE;
const rows = H;

const ID = "camera/fake/raw12p";
const RING = 8; // recorder-territory depth: a lagging FIFO consumer stays lossless
// Advertise in the PACKED representation: maxWidth/maxHeight/maxBytes bound the
// packed footprint (the tap publishes width=rowBytes, height=rows), while width/
// height carry the TRUE image dims and stride carries the packed row bytes.
P.advertise({
  id: ID,
  pixelFormat: "Mono8", // opaque label (fake wire format); packing is byte-copy
  dtype: "U8", // the packed payload is a raw byte stream
  width: W,
  height: H,
  channels: 1,
  stride: rowBytes,
  bytesPerFrame,
  maxWidth: rowBytes,
  maxHeight: rows,
  maxBytes: bytesPerFrame,
  ringDepth: RING,
});

// --- 1: consumer-gated — attached but not connected → parked (no frames) ------
assert.equal(A.attachRaw12pPipe(camera, ID), true, "attachRaw12pPipe succeeds");
await sleep(250); // if the tap were running it would ingest many frames
{
  const p = A.raw12pProbeAll()[ID];
  assert(p, "raw12p pipe appears in raw12pProbeAll while attached");
  assert.equal(p.name, ID, "raw12p meter name == pipeId (node id)");
  assert.equal(
    p.inputs.frame.count,
    0,
    `parked (no consumer) → zero frames ingested, got ${p?.inputs.frame.count}`,
  );
  console.log("30-raw12p: consumer-gated (parked → 0 frames) OK.");
}

// --- 2 + 3: connect → FIFO read + packed byte-length + deviceTimestamp --------
const { shmName } = P.connect(ID); // 0→1 edge fires the gate → tap registers
const rh = reader.open(shmName);
const dst = new ArrayBuffer(bytesPerFrame);
let sawDeviceTs = false;
{
  const WANT = 5;
  const delivered: number[] = [];
  let drops = 0;
  let want = 1;
  const deadline = Date.now() + 8000;
  while (delivered.length < WANT && Date.now() < deadline) {
    const r = reader.readSeqInto(rh, dst, BigInt(want));
    if (r === null) continue; // torn read — retry same seq
    if (isGone(r)) {
      drops += Number(r.oldestSeq) - want;
      want = Number(r.oldestSeq);
      continue;
    }
    if (isOk(r)) {
      assert.equal(Number(r.seq), want, "readSeqInto returns the requested seq");
      // The published active geometry accounts for EXACTLY the wire payload
      // (channels=1, 1 byte/elem ⇒ width*height == payload bytes). This is the
      // verbatim-copy proof: no expand/repack changed the byte count.
      assert.equal(
        r.width * r.height,
        bytesPerFrame,
        `packed payload byte-length: ${r.width}*${r.height} == ${bytesPerFrame}`,
      );
      assert.equal(r.height, rows, "active rows == packed row count");
      if (r.meta && typeof r.meta.deviceTimestamp === "bigint") sawDeviceTs = true;
      delivered.push(want);
      want += 1;
      continue;
    }
    await sleep(3); // NotYet — back off
  }
  assert.equal(delivered.length, WANT, `FIFO delivered ${WANT} frames in order`);
  for (let i = 1; i < delivered.length; i++)
    assert(delivered[i]! > delivered[i - 1]!, "delivered seq strictly increases");
  // deviceTimestamp plumbing: the tap stamps it EXACTLY like Frame construction
  // (arv timestamp + the owner's calibrated dt). The fake camera has no
  // TimestampLatch, so dt=0 (uncalibrated) — but the raw device counter is
  // non-zero, so the field is carried through the slot to the reader.
  assert(sawDeviceTs, "deviceTimestamp present on the packed frames");
  console.log(
    `30-raw12p: FIFO end-to-end OK (${WANT} frames, packed ${bytesPerFrame}B ` +
      `= ${rowBytes}x${rows}, deviceTimestamp carried, ${drops} drop-accounted).`,
  );

  const p = A.raw12pProbeAll()[ID];
  assert(p && p.inputs.frame.count > 0, "tap ingested frames once connected");
  console.log("30-raw12p: packed byte-length + producer metered after connect OK.");
}

// --- 4: detach STOPS publishing + idempotency + orderly teardown -------------
assert.equal(A.detachRaw12pPipe(ID), true, "detach removes the binding");
const seqAfterDetach = (() => {
  // Drain to the current latest, then confirm no NEW frame lands post-detach.
  let last = 0;
  for (let i = 0; i < 64; i++) {
    const r = reader.readSeqInto(rh, dst, BigInt(last + 1));
    if (isOk(r)) last = Number(r.seq);
    else break;
  }
  return last;
})();
await sleep(250); // a live tap would publish several frames in this window
{
  const r = reader.readSeqInto(rh, dst, BigInt(seqAfterDetach + 1));
  assert(
    !isOk(r),
    `no frame published after detach (latest stayed ${seqAfterDetach})`,
  );
  console.log("30-raw12p: detach stops publishing OK.");
}
assert.equal(A.detachRaw12pPipe(ID), false, "detach is idempotent");
assert.equal(A.raw12pProbeAll()[ID], undefined, "detached id absent from registry");

reader.close(rh);
P.disconnect(ID);
P.close(ID);
P.drop(ID);
camera.release?.();
cleanup();
console.log("30-raw12p: detach idempotency + orderly teardown complete — exiting naturally.");
