// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Dynamic pipe lifecycle: churn (create/destroy → no leaked
// segments), resize (active w/h varies inside a MAX-sized ring, no segment
// recreation), and reuse-safe identity (epoch bump → new segment → a stale
// consumer sees CLOSED). Run UNSANDBOXED: /opt/homebrew/bin/node <file>.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Pipe, __origin__, cleanup } from "core";

type ReaderHandle = object;
type FrameResult = { seq: bigint; width: number; height: number; meta: { tCapture: number } };
type ReaderAddon = {
  open(seg: string): ReaderHandle;
  readInto(h: ReaderHandle, dest: ArrayBuffer, lastSeq: bigint): FrameResult | { closed: true } | null;
  close(h: ReaderHandle): void;
};

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(
  join(dirname(__origin__), `${prefix}-shm-reader.node`),
) as ReaderAddon;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isClosed = (r: unknown): r is { closed: true } =>
  typeof r === "object" && r !== null && (r as { closed?: boolean }).closed === true;

const P = Pipe as unknown as {
  advertise(spec: Record<string, unknown>): number;
  connect(id: string): { shmName: string; epoch: number; spec: { maxBytes: number } };
  disconnect(id: string): number;
  offerFrame(id: string, w: number, h: number, byte: number): void;
  installTestGate(id: string): void;
  testGateLog(id: string): boolean[];
  close(id: string): void;
  drop(id: string): void;
};

const baseSpec = (id: string, extra: Record<string, unknown> = {}) => ({
  id, pixelFormat: "Mono8", dtype: "U8", width: 4, height: 4, channels: 1,
  stride: 4, bytesPerFrame: 16, ringDepth: 3, ...extra,
});

// ---- churn: create/destroy N pipes → every segment unlinked, no leak -------
{
  const N = 20;
  const names: string[] = [];
  for (let i = 0; i < N; i++) {
    const id = `churn:${i}`;
    P.advertise(baseSpec(id));
    names.push(P.connect(id).shmName);
  }
  for (let i = 0; i < N; i++) P.drop(`churn:${i}`);
  // Each dropped pipe's segment was shm_unlink'd → a fresh open fails.
  for (const name of names)
    assert.throws(() => reader.open(name), /shm_open/, `leaked segment ${name}`);
}

// ---- resize: active w/h varies inside a max ring, no recreation ------------
{
  const id = "resize:1";
  const maxW = 16, maxH = 16, ch = 1, maxBytes = maxW * maxH * ch;
  P.advertise(baseSpec(id, {
    width: 8, height: 8, bytesPerFrame: 8 * 8 * ch, ringDepth: 4,
    maxWidth: maxW, maxHeight: maxH, maxBytes,
  }));
  const handle = P.connect(id);
  assert.equal(handle.spec.maxBytes, maxBytes);
  const rh = reader.open(handle.shmName);
  const dest = new ArrayBuffer(maxBytes);

  const readActive = (lastSeq: bigint): FrameResult => {
    for (let i = 0; i < 50; i++) {
      const r = reader.readInto(rh, dest, lastSeq);
      if (r && !isClosed(r)) return r;
    }
    throw new Error("no frame");
  };

  P.offerFrame(id, 4, 4, 0xaa); // small active frame in the max ring
  let r = readActive(0n);
  assert.equal(r.width, 4);
  assert.equal(r.height, 4);
  for (let k = 0; k < 4 * 4; k++) assert.equal(new Uint8Array(dest)[k], 0xaa);

  P.offerFrame(id, 12, 10, 0xbb); // resized — SAME segment, no recreation
  r = readActive(r.seq);
  assert.equal(r.width, 12);
  assert.equal(r.height, 10);
  for (let k = 0; k < 12 * 10; k++) assert.equal(new Uint8Array(dest)[k], 0xbb);

  reader.close(rh);
  P.close(id);
  P.drop(id);
}

// ---- reuse-safe identity: epoch bump → new segment, stale sees CLOSED ------
{
  const id = "reuse:x";
  const dest = new ArrayBuffer(16);
  const e1 = P.advertise(baseSpec(id));
  const h1 = P.connect(id);
  assert.equal(h1.epoch, e1);
  const rh = reader.open(h1.shmName);
  P.offerFrame(id, 4, 4, 0x11);
  const first = reader.readInto(rh, dest, 0n);
  assert(first && !isClosed(first), "got a frame on epoch 1");
  const lastSeq = (first as FrameResult).seq;

  P.drop(id); // sets CLOSED, then unlinks the old segment
  let sawClosed = false;
  for (let i = 0; i < 100; i++) {
    if (isClosed(reader.readInto(rh, dest, lastSeq))) {
      sawClosed = true;
      break;
    }
    await sleep(2);
  }
  assert(sawClosed, "stale consumer observes CLOSED after drop");

  // Reuse the same id → epoch bumps → a DIFFERENT segment name.
  const e2 = P.advertise(baseSpec(id));
  assert(e2 > e1, `epoch bumped ${e1} -> ${e2}`);
  const h2 = P.connect(id);
  assert.notEqual(h2.shmName, h1.shmName, "reused id → new segment");
  assert.equal(h2.epoch, e2);
  // The stale consumer (old mapping) still only ever sees CLOSED — never binds
  // the reused id's new segment.
  assert(isClosed(reader.readInto(rh, dest, lastSeq)), "stale stays CLOSED");

  reader.close(rh);
  P.close(id);
  P.drop(id);
}

// ---- consumer gate: immediate-on-register + 0↔1 edges only -----------
{
  const id = "gate:x";
  P.advertise(baseSpec(id));
  P.installTestGate(id); // refcount 0 → immediate fire(false)
  assert.deepEqual(P.testGateLog(id), [false], "immediate fire on register");
  P.connect(id); // 0→1 → true
  P.connect(id); // 1→2 → no edge
  assert.deepEqual(P.testGateLog(id), [false, true], "0→1 wakes; 1→2 no fire");
  P.disconnect(id); // 2→1 → no edge
  P.disconnect(id); // 1→0 → false
  assert.deepEqual(P.testGateLog(id), [false, true, false], "→0 parks");
  // Re-register while a consumer is present reconciles to the CURRENT state.
  P.connect(id);
  P.installTestGate(id); // refcount 1 → immediate fire(true)
  assert.deepEqual(P.testGateLog(id), [true], "re-register reconciles to current");
  P.disconnect(id);
  P.close(id);
  P.drop(id);
}

cleanup();
console.log("pipe lifecycle tests passed.");
