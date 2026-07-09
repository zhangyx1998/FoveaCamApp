// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// multi-fovea-recording rulings 9 + 10 + R-1 transport re-base: the COMPRESSION
// brick (`attachCompressPipe`). A native thread reads a SOURCE raw12p pipe via
// an IN-PROCESS OwnedFrame tap (NOT a SHM ring — rings = IPC/JS-worker
// boundaries ONLY, ruled 2026-07-09), zlib-compresses each frame INDEPENDENTLY,
// and republishes an opaque `/zlib` blob into an output pipe via the ring-v5
// payloadBytes path. The recorder (a JS-worker consumer) reads the OUTPUT ring —
// that boundary stays a ring, correctly.
//
// NO hardware: the Aravis fake camera drives a `camera/.../raw12p` packed tap
// (as in test 30 — a whole-byte Mono8 wire format proves the format-agnostic
// plumbing; a genuine 12p wire capture is rig-gated). Compress taps THAT source.
// Proves:
//   1. Consumer-gated demand cascade: connecting the OUTPUT pipe opens the tap +
//      connects the raw12p SOURCE (so its capture tap runs) AND spawns the
//      runner; the source is idle until then.
//   2. Round-trip byte-identity: each output blob decompresses (node zlib) to
//      the EXACT raw12p source frame bytes at the same deviceTimestamp
//      (per-frame independent → decompresses alone); okResult.bytes == the
//      compressed blob length; source width/height forwarded.
//   3. The output advert's pixelFormat carries the `/zlib` suffix; the topology
//      row is kind "compress" with the source as its input edge; the meter probe
//      reports sane ingest counts.
//   4. detach tears down cleanly (close tap + join runner + release source) →
//      natural exit 0.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/32-compress-pipe.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { Aravis, Pipe, Topology, __origin__, cleanup } from "core";

type ReaderHandle = object;
type Meta = { deviceTimestamp?: bigint; systemTimestamp?: bigint };
type Ok = {
  seq: bigint;
  width: number;
  height: number;
  bytes?: number;
  meta: Meta;
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
  list(): Array<{ id: string; spec: { pixelFormat: string } }>;
};
const A = Aravis as unknown as {
  enableFakeCamera(): void;
  attachRaw12pPipe(camera: unknown, pipeId: string): boolean;
  detachRaw12pPipe(pipeId: string): boolean;
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
const isGone = (r: SeqResult): r is Gone =>
  typeof r === "object" && r !== null && (r as Gone).gone === true;

// --- fake-camera raw12p geometry (probe one frame) ---------------------------
A.enableFakeCamera();
const cams = await A.Camera.list();
assert(cams.length > 0, "fake camera enumerated");
const camera = cams[0]!;
const probe = await camera.grab(2_000_000);
const [H, W] = probe.raw.shape as [number, number];
const CH = probe.raw.channels ?? (probe.raw.shape.length === 3 ? probe.raw.shape[2]! : 1);
const BPE = probe.raw.BYTES_PER_ELEMENT;
probe.release?.();
const bytesPerFrame = W * H * CH * BPE; // whole-byte fake → packed == unpacked
const rowBytes = W * CH * BPE;
const rows = H;

// --- pipes: a raw12p SOURCE (packed tap) + a `/zlib` COMPRESS output ----------
const SRC = "test/compress/raw12p";
const OUT = "test/compress/out";
// Worst-case compressed size ≈ srcLen + srcLen/1000 + tens of bytes; generous so
// a near-incompressible frame never trips offer()'s cap.
const OUT_MAX = bytesPerFrame + Math.ceil(bytesPerFrame / 1000) + 128;
const N = 5;

P.advertise({
  id: SRC,
  pixelFormat: "Mono8", // opaque label (fake wire format); packing is byte-copy
  dtype: "U8",
  width: W,
  height: H,
  channels: 1,
  stride: rowBytes,
  bytesPerFrame,
  maxWidth: rowBytes,
  maxHeight: rows,
  maxBytes: bytesPerFrame,
  ringDepth: 16,
});
P.advertise({
  id: OUT,
  pixelFormat: "Mono8/zlib",
  dtype: "U8",
  width: W,
  height: H,
  channels: 1,
  stride: rowBytes,
  bytesPerFrame,
  // Compress forwards the SOURCE packed dims (width=rowBytes, height=rows), so
  // the output slot must admit that footprint (offer() guards width>maxWidth).
  maxWidth: rowBytes,
  maxHeight: rows,
  maxBytes: OUT_MAX,
  ringDepth: 16,
});

assert.equal(A.attachRaw12pPipe(camera, SRC), true, "attachRaw12pPipe succeeds");
assert.equal(A.attachCompressPipe(SRC, OUT, { level: -1 }), true,
  "attachCompressPipe succeeds");

// --- 1: consumer-gated — source + runner idle until the OUTPUT is connected ---
{
  await sleep(200); // a live tap/runner would ingest many frames here
  const probe = A.compressProbeAll()[OUT];
  assert(probe, "compress pipe present in compressProbeAll while attached");
  assert.equal(probe.inputs.frame.count, 0, "runner parked → 0 frames ingested");
  console.log("32-compress: consumer-gated (parked → 0 frames) OK.");
}

// Connect the raw12p SOURCE ring too, so we can byte-verify against it (its tap
// also runs once ANY consumer connects; compress adds a second refcount).
const { shmName: srcShm } = P.connect(SRC);
const srh = reader.open(srcShm);
const srcDst = new ArrayBuffer(bytesPerFrame);

// Connecting the OUTPUT cascades: gate → open tap + connect(SRC) + spawn runner.
const { shmName: outShm } = P.connect(OUT);
const orh = reader.open(outShm);
const outDst = new ArrayBuffer(OUT_MAX);

// FIFO-read output seq `want`, polling NotYet with a deadline.
const readOut = async (want: number): Promise<Ok> => {
  const deadline = Date.now() + 5000;
  let w = want;
  for (;;) {
    const r = reader.readSeqInto(orh, outDst, BigInt(w));
    if (isOk(r)) return r;
    if (isGone(r)) {
      w = Number(r.oldestSeq); // lagged the ring — jump forward
      continue;
    }
    assert(!(r && "closed" in r), `output seq ${w} unexpectedly Closed`);
    if (Date.now() > deadline) throw new Error(`timeout waiting for output seq ${w}`);
    await sleep(2);
  }
};

// --- 2: round-trip byte-identity vs the raw12p ring + source identity ---------
{
  // Collect raw12p source frames by deviceTimestamp as they arrive (FIFO), so we
  // can byte-verify each compressed output against its exact source bytes.
  const srcByTs = new Map<string, Buffer>();
  let srcWant = 1;
  const drainSrc = () => {
    for (let i = 0; i < 64; i++) {
      const r = reader.readSeqInto(srh, srcDst, BigInt(srcWant));
      if (isGone(r)) { srcWant = Number(r.oldestSeq); continue; }
      if (!isOk(r)) break;
      const ts = r.meta.deviceTimestamp;
      if (typeof ts === "bigint")
        srcByTs.set(ts.toString(), Buffer.from(outByteCopy(srcDst, r.width * r.height)));
      srcWant += 1;
    }
  };

  let matched = 0;
  for (let want = 1; want <= N; want++) {
    const r = await readOut(want);
    assert.equal(r.width, rowBytes, "forwarded source width (packed row bytes)");
    assert.equal(r.height, rows, "forwarded source height (packed rows)");
    assert(typeof r.bytes === "number" && r.bytes > 0, "okResult.bytes = blob length");
    const blob = Buffer.from(outDst, 0, r.bytes!);
    const plain = inflateSync(blob);
    assert.equal(plain.length, bytesPerFrame,
      `frame ${want} decompresses to the source byte count`);
    // Byte-identity against the raw12p ring at the same deviceTimestamp.
    drainSrc();
    const ts = r.meta.deviceTimestamp;
    if (typeof ts === "bigint") {
      const srcBytes = srcByTs.get(ts.toString());
      if (srcBytes) {
        assert(plain.equals(srcBytes),
          `frame ${want} byte-identical to the raw12p source frame`);
        matched++;
      }
    }
  }
  assert(matched >= 1, `at least one output frame byte-verified vs the raw12p ring (matched=${matched})`);
  console.log(`32-compress: round-trip byte-identity over ${N} frames via the raw12p tap (${matched} byte-verified) OK.`);
}

// A tight copy of the first `len` bytes of an ArrayBuffer (raw12p active bytes).
function outByteCopy(buf: ArrayBuffer, len: number): Uint8Array {
  return new Uint8Array(buf.slice(0, len));
}

// --- 3: /zlib advert suffix + topology row + meter probe ----------------------
{
  const outEntry = P.list().find((e) => e.id === OUT);
  assert(outEntry, "output pipe listed");
  assert.equal(outEntry!.spec.pixelFormat, "Mono8/zlib",
    "output advert pixelFormat carries the /zlib suffix");

  const row = T.report().find((n) => n.id === OUT);
  assert(row, "compress pipe appears in Topology.report()");
  assert.equal(row!.kind, "compress", "topology kind == compress");
  assert(row!.inputs.some((i) => i.from === SRC),
    "topology input edge == the raw12p source pipe");
  assert(
    (row!.output?.pixelFormat ?? "").includes("/zlib"),
    "topology output format carries /zlib",
  );

  const probe = A.compressProbeAll()[OUT];
  assert(probe && probe.inputs.frame.count >= N,
    `meter probe reports sane ingest count (>= ${N})`);
  console.log("32-compress: /zlib advert + compress topology row + meter probe OK.");
}

// --- 4: detach tears down cleanly → natural exit ------------------------------
reader.close(orh);
reader.close(srh);
assert.equal(A.detachCompressPipe(OUT), true, "detach removes the binding");
assert.equal(A.detachCompressPipe(OUT), false, "detach is idempotent");
assert.equal(A.compressProbeAll()[OUT], undefined, "detached id absent from registry");
A.detachRaw12pPipe(SRC);
P.disconnect(OUT);
P.close(OUT);
P.drop(OUT);
P.disconnect(SRC);
P.close(SRC);
P.drop(SRC);
camera.release?.();
cleanup();
console.log("32-compress-pipe: orderly teardown complete — exiting naturally.");
