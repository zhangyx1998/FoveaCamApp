// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// multi-fovea-recording rulings 9 + 10: the COMPRESSION brick (`attachCompressPipe`).
// A native thread FIFO-reads a SOURCE pipe, zlib-compresses each frame
// INDEPENDENTLY, and republishes an opaque `/zlib` blob into an output pipe via
// the ring-v5 payloadBytes path. NO hardware — a synthetic source
// (`Pipe.offerFrame`, one uniform-byte frame per seq) feeds the brick; the test
// decompresses each output blob with node's own zlib and checks byte-identity.
// Proves:
//   1. Consumer-gated demand cascade: connecting the OUTPUT pipe spins the runner
//      AND connects the SOURCE (so its synthetic producer writes); the source is
//      idle until then.
//   2. Round-trip byte-identity: each output blob decompresses (node zlib) to the
//      EXACT source frame bytes (per-frame independent → decompresses alone).
//   3. Source identity forwarded: each compressed frame carries the source
//      frame's width/height; okResult.bytes == the compressed blob length.
//   4. The output advert's pixelFormat carries the `/zlib` suffix; the topology
//      row is kind "compress" with the source as its input edge; the meter probe
//      reports sane ingest counts.
//   5. detach tears down cleanly (join runner + release source) → natural exit 0.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/32-compress-pipe.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { Aravis, Pipe, Topology, __origin__ } from "core";

type ReaderHandle = object;
type Ok = {
  seq: bigint;
  width: number;
  height: number;
  bytes?: number;
};
type NotYet = { notYet: true };
type Gone = { gone: true; oldestSeq: bigint };
type Closed = { closed: true };
type SeqResult = Ok | NotYet | Gone | Closed | null;
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
  offerFrame(id: string, w: number, h: number, byte: number): void;
  list(): Array<{ id: string; spec: { pixelFormat: string } }>;
};
const A = Aravis as unknown as {
  attachCompressPipe(
    sourcePipeId: string,
    pipeId: string,
    options?: { level?: number },
  ): boolean;
  detachCompressPipe(pipeId: string): boolean;
  compressProbeAll(): Record<
    string,
    { name: string; inputs: { frame: { count: number } } }
  >;
};
const T = Topology as unknown as {
  report(): Array<{
    id: string;
    kind: string;
    inputs: Array<{ from: string }>;
    output?: { pixelFormat?: string };
  }>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isOk = (r: SeqResult): r is Ok =>
  typeof r === "object" && r !== null && "seq" in r;

// --- pipes: an uncompressed SOURCE + a `/zlib` COMPRESS output ----------------
const SRC = "test/compress/src";
const OUT = "test/compress/out";
const W = 16, H = 16, CH = 1;
const FRAME_BYTES = W * H * CH; // 256
// Worst-case compressed size ≈ srcLen + srcLen/1000 + a few tens of bytes;
// generous here so a near-incompressible frame never trips offer()'s cap.
const OUT_MAX = FRAME_BYTES * 2 + 128;
const N = 5;

P.advertise({
  id: SRC, pixelFormat: "Mono8", dtype: "U8", width: W, height: H,
  channels: CH, stride: W * CH, bytesPerFrame: FRAME_BYTES, ringDepth: 16,
});
P.advertise({
  id: OUT, pixelFormat: "Mono8/zlib", dtype: "U8", width: W, height: H,
  channels: CH, stride: W * CH, bytesPerFrame: FRAME_BYTES,
  maxBytes: OUT_MAX, ringDepth: 16,
});

assert.equal(A.attachCompressPipe(SRC, OUT, { level: -1 }), true,
  "attachCompressPipe succeeds");

// --- 1: consumer-gated — source idle until the OUTPUT is connected ------------
{
  // Not connected yet → the runner is parked → offering source frames writes
  // nothing the runner consumes (source refcount is 0, so offerFrame no-ops).
  P.offerFrame(SRC, W, H, 200); // dropped: source has no consumer (refcount 0)
  const probe = A.compressProbeAll()[OUT];
  assert(probe, "compress pipe present in compressProbeAll while attached");
  assert.equal(probe.inputs.frame.count, 0, "runner parked → 0 frames ingested");
  console.log("32-compress: consumer-gated (parked → 0 frames) OK.");
}

// Connecting the OUTPUT cascades: gate → connect(SRC) + spawn runner.
const { shmName } = P.connect(OUT);
const rh = reader.open(shmName);
const dst = new ArrayBuffer(OUT_MAX);

// FIFO-read output seq `want`, polling NotYet with a deadline.
const readOut = async (want: number): Promise<Ok> => {
  const deadline = Date.now() + 3000;
  for (;;) {
    const r = reader.readSeqInto(rh, dst, BigInt(want));
    if (isOk(r)) return r;
    assert(!(r && "gone" in r), `output seq ${want} unexpectedly Gone`);
    assert(!(r && "closed" in r), `output seq ${want} unexpectedly Closed`);
    if (Date.now() > deadline) throw new Error(`timeout waiting for output seq ${want}`);
    await sleep(2);
  }
};

// --- 2 + 3: round-trip byte-identity + source identity forwarded --------------
{
  // Offer N source frames, each a distinct uniform byte (seq) — the source is
  // now connected (cascade), so these write into the source ring.
  for (let s = 1; s <= N; s++) P.offerFrame(SRC, W, H, s & 0xff);

  for (let want = 1; want <= N; want++) {
    const r = await readOut(want);
    assert.equal(Number(r.seq), want, `output seq ${want}`);
    assert.equal(r.width, W, "forwarded source width");
    assert.equal(r.height, H, "forwarded source height");
    assert(typeof r.bytes === "number" && r.bytes > 0, "okResult.bytes = blob length");
    // Decompress the opaque blob (first `bytes` of dst) with node zlib.
    const blob = Buffer.from(dst, 0, r.bytes!);
    const plain = inflateSync(blob);
    assert.equal(plain.length, FRAME_BYTES,
      `frame ${want} decompresses to the source byte count`);
    for (let i = 0; i < FRAME_BYTES; i++)
      assert.equal(plain[i], want & 0xff, `frame ${want} byte ${i} byte-identical`);
  }
  console.log(`32-compress: round-trip byte-identity over ${N} frames (per-frame independent) OK.`);
}

// --- 4: /zlib advert suffix + topology row + meter probe ----------------------
{
  const outEntry = P.list().find((e) => e.id === OUT);
  assert(outEntry, "output pipe listed");
  assert.equal(outEntry!.spec.pixelFormat, "Mono8/zlib",
    "output advert pixelFormat carries the /zlib suffix");

  const row = T.report().find((n) => n.id === OUT);
  assert(row, "compress pipe appears in Topology.report()");
  assert.equal(row!.kind, "compress", "topology kind == compress");
  assert(row!.inputs.some((i) => i.from === SRC),
    "topology input edge == the source pipe");
  assert(
    (row!.output?.pixelFormat ?? "").includes("/zlib"),
    "topology output format carries /zlib",
  );

  const probe = A.compressProbeAll()[OUT];
  assert(probe && probe.inputs.frame.count >= N,
    `meter probe reports sane ingest count (>= ${N})`);
  console.log("32-compress: /zlib advert + compress topology row + meter probe OK.");
}

// --- 5: detach tears down cleanly → natural exit ------------------------------
reader.close(rh);
assert.equal(A.detachCompressPipe(OUT), true, "detach removes the binding");
assert.equal(A.detachCompressPipe(OUT), false, "detach is idempotent");
assert.equal(A.compressProbeAll()[OUT], undefined, "detached id absent from registry");
P.disconnect(OUT);
P.close(OUT);
P.drop(OUT);
P.close(SRC);
P.drop(SRC);
console.log("32-compress-pipe: orderly teardown complete — exiting naturally.");
