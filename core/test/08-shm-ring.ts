#!npx ts-node
// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { Shm, Pipe, __origin__, cleanup } from "core";
import type { ShmDescriptor } from "core/Shm";

type ReaderHandle = object;
type ReaderResult = {
  seq: bigint;
  gen: number;
  retries: number;
  meta: {
    tCapture: number;
    convertMs: number;
    deviceTimestamp?: bigint;
    systemTimestamp?: bigint;
  };
};
type ReaderResultWithData = ReaderResult & { data: Uint8Array };
type ClosedResult = { closed: true };
type ReaderAddon = {
  open(seg: string): ReaderHandle;
  readInto(
    handle: ReaderHandle,
    dest: ArrayBuffer,
    lastSeq: bigint,
  ): ReaderResult | ClosedResult | null;
  close(handle: ReaderHandle): void;
};
type HammerMessage = { kind: "ready" | "done"; descriptor: ShmDescriptor };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isClosed = (r: unknown): r is ClosedResult =>
  typeof r === "object" && r !== null && (r as ClosedResult).closed === true;

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(
  join(dirname(__origin__), `${prefix}-shm-reader.node`),
) as ReaderAddon;

function bytes(shape: number[], channels: number): number {
  return shape.reduce((p, n) => p * n, channels);
}

function readOnce(
  handle: ReaderHandle,
  descriptor: ShmDescriptor,
  lastSeq = 0n,
): ReaderResultWithData | null {
  const out = new ArrayBuffer(bytes(descriptor.shape, descriptor.channels));
  const result = reader.readInto(handle, out, lastSeq);
  return result ? { ...result, data: new Uint8Array(out) } : null;
}

function assertPattern(result: ReaderResultWithData): void {
  const expected = Number(result.meta.tCapture) % 251;
  for (const byte of result.data)
    assert.equal(byte, expected, `torn SHM read at seq ${result.seq}`);
}

{
  const topics = [
    "camera:L:1234567890",
    "camera:C:1234567891",
    "camera:R:1234567892",
    "tracking-single:center",
    "tracking-single:center.diff",
    "disparity-scope:center.disparity",
    "manual-control:C",
    "capture:calibration-session-with-a-long-name#0",
    "capture:calibration-session-with-a-long-name#1",
    "capture:calibration-session-with-a-long-name#2",
    ...Array.from({ length: 64 }, (_, i) => `capture:run-${i}#${i % 3}`),
  ];
  const keys = topics.map((t) => Shm.topicKey(t));
  assert.equal(Shm.topicKey(topics[0]), keys[0]);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) {
    assert.match(key, /^[0-9a-z]+$/);
    assert(`/fv.${key}.g4294967295`.length <= 31);
  }
  // Known FNV-1a 32-bit collision. The first topic claims the process-local
  // key; the second must fail loudly instead of cross-wiring live rings.
  assert.equal(Shm.topicKey("costarring"), "q5yxel");
  assert.throws(() => Shm.topicKey("liquid"), /topic key collision/);
}

{
  const writer = new Shm.Writer(Shm.topicKey("shm-roundtrip"));
  writer.nextSlot([2, 3], 4).debugFillPattern(10);
  const descriptor = writer.publish({ tCapture: 10, convertMs: 2 });
  const handle = reader.open(descriptor.shm.seg);
  const result = readOnce(handle, descriptor);
  assert(result);
  assert.equal(result.seq, 1n);
  assert.equal(result.gen, 1);
  assert.equal(result.meta.convertMs, 2);
  assertPattern(result);
  reader.close(handle);
  writer.close();
}

{
  // V13: write() must reach shared memory (readSnapshot().set() would not
  // under the Electron cage), and copyTo() must read the slot back into a
  // caller buffer.
  const writer = new Shm.Writer(Shm.topicKey("shm-write-copyto"));
  const src = new Uint8Array(2 * 3 * 4);
  for (let i = 0; i < src.length; i++) src[i] = (i * 7 + 3) % 251;
  const slot = writer.nextSlot([2, 3], 4);
  slot.write(src);
  const snapshot = slot.readSnapshot();
  assert.deepEqual(Array.from(snapshot), Array.from(src));
  const descriptor = writer.publish({ tCapture: 5 });
  const handle = reader.open(descriptor.shm.seg);
  const result = readOnce(handle, descriptor);
  assert(result);
  assert.deepEqual(Array.from(result.data.slice(0, src.length)), Array.from(src));
  const out = new Uint8Array(src.length);
  slot.copyTo(out);
  assert.deepEqual(Array.from(out), Array.from(src));
  assert.throws(() => slot.write(new Uint8Array(src.length - 1)), /byte length/);
  assert.throws(() => slot.copyTo(new Uint8Array(src.length - 1)), /too small/);
  reader.close(handle);
  writer.close();
}

{
  const writer = new Shm.Writer(Shm.topicKey("shm-generation"));
  writer.nextSlot([2, 2], 4).debugFillPattern(1);
  const first = writer.publish({ tCapture: 1 });
  const oldReader = reader.open(first.shm.seg);
  writer.nextSlot([3, 2], 4).debugFillPattern(2);
  const second = writer.publish({ tCapture: 2 });
  assert.notEqual(first.shm.seg, second.shm.seg);
  const oldRead = readOnce(oldReader, first);
  assert(oldRead);
  assert.equal(oldRead.gen, 1);
  assertPattern(oldRead);
  const newReader = reader.open(second.shm.seg);
  const newRead = readOnce(newReader, second);
  assert(newRead);
  assert.equal(newRead.gen, 2);
  assertPattern(newRead);
  reader.close(oldReader);
  reader.close(newReader);
  writer.close();
}

{
  const writer = new Shm.Writer(Shm.topicKey("shm-sweep"));
  writer.nextSlot([2, 2], 4).debugFillPattern(3);
  const descriptor = writer.publish({ tCapture: 3 });
  const handle = reader.open(descriptor.shm.seg);
  assert(readOnce(handle, descriptor));
  reader.close(handle);
  const swept = Shm.sweep();
  assert(swept >= 1);
  assert.throws(() => reader.open(descriptor.shm.seg), /shm_open/);
  writer.close();
}

{
  // Keep the worker hammer last: Node tears down the worker's native addon
  // environment independently, and this test only needs main-thread cleanup
  // after the worker exits.
  const worker = new Worker(
    `
      import { parentPort } from "node:worker_threads";
      import { Shm } from "core";
      const writer = new Shm.Writer(Shm.topicKey("shm-hammer"));
      let descriptor = null;
      writer.nextSlot([256, 256], 4).debugFillPattern(0);
      descriptor = writer.publish({ tCapture: 0, convertMs: 0 });
      parentPort.postMessage({ kind: "ready", descriptor });
      await new Promise((resolve) => parentPort.once("message", resolve));
      for (let i = 1; i < 1500; i++) {
        writer.nextSlot([256, 256], 4).debugFillPattern(i);
        descriptor = writer.publish({ tCapture: i, convertMs: i % 7 });
      }
      parentPort.postMessage({ kind: "done", descriptor });
      writer.close();
    `,
    { eval: true },
  );
  const ready = await new Promise<ShmDescriptor>((resolve, reject) => {
    worker.on("message", (message: HammerMessage) => {
      if (message.kind === "ready") resolve(message.descriptor);
    });
    worker.on("error", reject);
  });
  const handle = reader.open(ready.shm.seg);
  worker.postMessage({ kind: "open" });
  let lastSeq = 0n;
  let reads = 0;
  let retries = 0;
  let poll: ReturnType<typeof setInterval> | null = null;
  const done = await new Promise<ShmDescriptor>((resolve, reject) => {
    worker.on("message", (message: HammerMessage) => {
      if (message.kind === "done") {
        if (poll) clearInterval(poll);
        poll = null;
        resolve(message.descriptor);
      }
    });
    worker.on("error", (error) => {
      if (poll) clearInterval(poll);
      reject(error);
    });
    poll = setInterval(() => {
      const result = readOnce(handle, ready, lastSeq);
      if (result) {
        lastSeq = result.seq;
        retries += result.retries;
        assertPattern(result);
        reads++;
      }
    }, 0);
    worker.on("exit", () => {
      if (poll) clearInterval(poll);
      poll = null;
    });
  });
  const final = readOnce(handle, done, lastSeq);
  if (final) {
    retries += final.retries;
    assertPattern(final);
    reads++;
  }
  assert(reads > 0);
  assert(retries >= 0);
  reader.close(handle);
}

{
  // Pipe scaffold: the publisher thread + synthetic producer thread
  // + reader-addon consumer, all off the JS loop. Exercises per-segment
  // ringDepth, the v2 CLOSED state signal, and consumer refcounting.
  const P = Pipe as any;
  const pipeId = "pipe-smoke";
  const width = 4;
  const height = 4;
  const channels = 1;
  const ringDepth = 4; // != SLOT_COUNT — proves per-segment depth + reader relax
  const bytesPerFrame = width * height * channels; // Mono8 = 16 bytes

  P.advertise({
    id: pipeId,
    pixelFormat: "Mono8",
    dtype: "U8",
    width,
    height,
    channels,
    stride: width * channels,
    bytesPerFrame,
    ringDepth,
  });
  P.attachSynthetic(pipeId, 200, 100); // ~5 ms/frame; byte = (100 + i) & 0xff

  const handle = P.connect(pipeId);
  assert.equal(handle.ringDepth, ringDepth);
  assert.equal(handle.headerLayout.layoutVersion, 5); // ring v5 (payloadBytes)
  assert.equal(P.consumers(pipeId), 1);

  const rh = reader.open(handle.shmName);
  const dest = new ArrayBuffer(bytesPerFrame);

  const nextFrame = async (
    lastSeq: bigint,
    timeoutMs = 2000,
  ): Promise<ReaderResult | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = reader.readInto(rh, dest, lastSeq);
      if (r && !isClosed(r)) return r as ReaderResult;
      if (Date.now() > deadline) return null;
      await sleep(2);
    }
  };

  const f1 = await nextFrame(0n);
  assert(f1, "pipe: expected a synthetic frame");
  const byte1 = new Uint8Array(dest)[0];
  // Uniform fill = (seed + tCapture) & 0xff — proves the producer frame reached
  // the consumer intact through the publisher thread's seqlock write.
  assert.equal(byte1, (100 + Number(f1!.meta.tCapture)) & 0xff);
  for (const b of new Uint8Array(dest)) assert.equal(b, byte1);

  const f2 = await nextFrame(f1!.seq);
  assert(f2 && f2.seq > f1!.seq, "pipe: seq advances as frames flow");

  // Refcount: a second consumer, then drop back to one — still producing.
  P.connect(pipeId);
  assert.equal(P.consumers(pipeId), 2);
  assert.equal(P.disconnect(pipeId), 1);
  assert(await nextFrame(f2!.seq), "pipe: still producing at one consumer");

  // Drop to zero → production pauses (thread stops); pipe stays advertised.
  assert.equal(P.disconnect(pipeId), 0);
  await sleep(50);
  let pausedSeq = 0n;
  {
    const r = reader.readInto(rh, dest, 0n);
    if (r && !isClosed(r)) pausedSeq = (r as ReaderResult).seq;
  }
  await sleep(80);
  {
    const r = reader.readInto(rh, dest, pausedSeq);
    assert(r === null || isClosed(r), "pipe: no new frames at zero consumers");
  }

  // Reconnect → production resumes on the same advertised pipe.
  P.connect(pipeId);
  assert.equal(P.consumers(pipeId), 1);
  const f4 = await nextFrame(pausedSeq);
  assert(f4 && f4.seq > pausedSeq, "pipe: resumes after reconnect");

  // Symmetric close: publisher sets CLOSED after its final frame; the consumer
  // drains remaining frames, then observes the explicit CLOSED signal.
  P.close(pipeId);
  let sawClosed = false;
  let last = f4!.seq;
  const closeDeadline = Date.now() + 2000;
  while (Date.now() < closeDeadline) {
    const r = reader.readInto(rh, dest, last);
    if (isClosed(r)) {
      sawClosed = true;
      break;
    }
    if (r) last = (r as ReaderResult).seq;
    await sleep(2);
  }
  assert(sawClosed, "pipe: consumer must observe explicit CLOSED after close()");

  reader.close(rh);
  P.drop(pipeId);
}

cleanup();
console.log("SHM ring smoke tests passed.");
