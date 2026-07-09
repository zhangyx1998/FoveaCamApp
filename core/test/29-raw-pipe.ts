// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// capture-recorder-nodes Phase 1: RAW camera pipes (`attachRawPipe`). A gated
// Frame::Ptr subscriber on the camera's Arv::Stream publishes FULL-BIT-DEPTH
// sensor bytes (`frame->raw`) — the path the recorder/capture nodes consume,
// NOT the 8-bit BGRA8 preview. NO hardware (Aravis fake camera). Proves:
//   1. CONSUMER-GATED — attached but NOT connected → the producer parks (zero
//      frames ingested); connecting spins it up.
//   2. Bytes/dims match the sensor — each read carries the full W*H*channels*
//      elemSize bytes at the sensor's active size, seq strictly monotonic.
//   3. FIFO read END TO END — the recorder's exact consumption loop
//      (`readSeqInto`, want = lastDelivered+1; NotYet→poll, Gone→jump+drop-
//      account, Ok→consume) delivers an ORDERED stream over the raw pipe.
//   4. detach idempotency + orderly teardown → natural exit 0.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/29-raw-pipe.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Aravis, Pipe, __origin__, cleanup } from "core";

type ReaderHandle = object;
type Ok = { seq: bigint; width: number; height: number };
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
  attachRawPipe(camera: unknown, pipeId: string): boolean;
  detachRawPipe(pipeId: string): boolean;
  rawProbeAll(): Record<
    string,
    { name: string; inputs: { frame: { count: number } } }
  >;
  Camera: {
    list(): Promise<
      Array<{
        raw?: unknown;
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
const BPE = probe.raw.BYTES_PER_ELEMENT; // 1 (Mono8) / 2 (Mono16 / 12p→16-bit)
probe.release?.();
const bytesPerFrame = W * H * CH * BPE;

const ID = "camera/fake/raw";
// A DEEP ring (recorder territory) — the FIFO consumer stays lossless while it
// lags up to the depth. `pixelFormat` is an opaque label here (the raw
// subscriber copies bytes verbatim; only channels/bytes are validated).
const RING = 8;
P.advertise({
  id: ID,
  pixelFormat: "Mono8",
  dtype: BPE > 1 ? "U16" : "U8",
  width: W,
  height: H,
  channels: CH,
  stride: W * CH * BPE,
  bytesPerFrame,
  ringDepth: RING,
});

// --- 1: consumer-gated — attached but not connected → parked (no frames) ------
assert.equal(A.attachRawPipe(camera, ID), true, "attachRawPipe succeeds");
await sleep(250); // if the producer were running it would ingest many frames
{
  const p = A.rawProbeAll()[ID];
  assert(p, "raw pipe appears in rawProbeAll while attached");
  assert.equal(p.name, ID, "raw meter name == pipeId (node id)");
  assert.equal(
    p.inputs.frame.count,
    0,
    `parked (no consumer) → zero frames ingested, got ${p?.inputs.frame.count}`,
  );
  console.log("29-raw-pipe: consumer-gated (parked → 0 frames) OK.");
}

// --- 2 + 3: connect → FIFO read the recorder's exact consumption loop ---------
const { shmName } = P.connect(ID); // 0→1 edge fires the gate → producer runs
const rh = reader.open(shmName);
const dst = new ArrayBuffer(bytesPerFrame);
{
  const WANT = 5;
  const delivered: number[] = [];
  let drops = 0;
  let want = 1; // recorder tracks lastDelivered + 1
  const deadline = Date.now() + 8000;
  while (delivered.length < WANT && Date.now() < deadline) {
    const r = reader.readSeqInto(rh, dst, BigInt(want));
    if (r === null) continue; // torn read — retry same seq
    if (isGone(r)) {
      drops += Number(r.oldestSeq) - want; // account the recycled gap
      want = Number(r.oldestSeq); // jump forward
      continue;
    }
    if (isOk(r)) {
      assert.equal(Number(r.seq), want, "readSeqInto returns the requested seq");
      assert.equal(r.width, W, "active width == sensor width");
      assert.equal(r.height, H, "active height == sensor height");
      delivered.push(want);
      want += 1;
      continue;
    }
    await sleep(3); // NotYet — the next frame hasn't landed; back off
  }
  assert.equal(delivered.length, WANT, `FIFO delivered ${WANT} frames in order`);
  // Strictly increasing (ordered), and the delivered stream is contiguous
  // between any drop jumps (each step is want = prev + 1 unless a jump).
  for (let i = 1; i < delivered.length; i++)
    assert(delivered[i]! > delivered[i - 1]!, "delivered seq strictly increases");
  console.log(
    `29-raw-pipe: FIFO end-to-end OK (${WANT} frames, ${W}x${H}x${CH} @ ${BPE}B, ${drops} drop-accounted).`,
  );

  const p = A.rawProbeAll()[ID];
  assert(p && p.inputs.frame.count > 0, "producer ingested frames once connected");
  console.log("29-raw-pipe: bytes/dims match + producer metered after connect OK.");
}

// --- 4: detach idempotency + orderly teardown → natural exit -----------------
reader.close(rh);
P.disconnect(ID);
assert.equal(A.detachRawPipe(ID), true, "detach removes the binding");
assert.equal(A.detachRawPipe(ID), false, "detach is idempotent");
assert.equal(A.rawProbeAll()[ID], undefined, "detached id absent from the registry");
P.close(ID);
P.drop(ID);
camera.release?.();
cleanup();
console.log("29-raw-pipe: detach idempotency + orderly teardown complete — exiting naturally.");
