// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// End-to-end pipe integration. Exercises the whole consumer
// transport with SYNTHETIC frames: advertise → connect (broker) → the reader
// addon (the same call the preload makes) reads N frames with correct
// bytes/seq → consumer refcount → symmetric CLOSED. No cameras, no live path.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/09-pipe.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Pipe, __origin__, cleanup } from "core";

type ReaderHandle = object;
type FrameResult = {
  seq: bigint;
  gen: number;
  retries: number;
  meta: { tCapture: number };
};
type ClosedResult = { closed: true };
type ReaderAddon = {
  open(seg: string): ReaderHandle;
  readInto(
    handle: ReaderHandle,
    dest: ArrayBuffer,
    lastSeq: bigint,
  ): FrameResult | ClosedResult | null;
  close(handle: ReaderHandle): void;
};

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(
  join(dirname(__origin__), `${prefix}-shm-reader.node`),
) as ReaderAddon;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isClosed = (r: unknown): r is ClosedResult =>
  typeof r === "object" && r !== null && (r as ClosedResult).closed === true;

// Broker is untyped at the root `core` import for the strip-types runner.
const P = Pipe as unknown as {
  advertise(spec: Record<string, unknown>): void;
  connect(id: string): {
    pipeId: string;
    shmName: string;
    spec: { bytesPerFrame: number };
    ringDepth: number;
    headerLayout: { layoutVersion: number; magic: string };
  };
  disconnect(id: string): number;
  consumers(id: string): number;
  close(id: string): void;
  attachSynthetic(id: string, fps: number, seed: number): void;
  drop(id: string): void;
};

{
  const id = "integration:mono8";
  const width = 8;
  const height = 6;
  const channels = 1;
  const ringDepth = 4;
  const bytesPerFrame = width * height * channels; // Mono8 = 48
  const seed = 50;

  P.advertise({
    id,
    pixelFormat: "Mono8",
    dtype: "U8",
    width,
    height,
    channels,
    stride: width * channels,
    bytesPerFrame,
    ringDepth,
  });
  P.attachSynthetic(id, 240, seed);

  // Broker handshake (the JS session brokers exactly this call).
  const handle = P.connect(id);
  assert(handle.shmName.startsWith("/fv.p"), "pipe segment name");
  assert.equal(handle.ringDepth, ringDepth);
  assert.equal(handle.spec.bytesPerFrame, bytesPerFrame);
  assert.equal(handle.headerLayout.layoutVersion, 5); // ring v5 (payloadBytes)
  assert.equal(P.consumers(id), 1);

  // Consumer read path (the reader addon — same the preload uses).
  const rh = reader.open(handle.shmName);
  const dest = new ArrayBuffer(bytesPerFrame);

  let lastSeq = 0n;
  let got = 0;
  const deadline = Date.now() + 4000;
  while (got < 8 && Date.now() < deadline) {
    const r = reader.readInto(rh, dest, lastSeq);
    if (r && !isClosed(r)) {
      assert(r.seq > lastSeq, "seq strictly increases");
      lastSeq = r.seq;
      const byte = new Uint8Array(dest)[0];
      // Synthetic fill = (seed + tCapture) & 0xff, uniform across the frame.
      assert.equal(byte, (seed + Number(r.meta.tCapture)) & 0xff);
      for (const b of new Uint8Array(dest)) assert.equal(b, byte);
      got++;
    } else {
      await sleep(2);
    }
  }
  assert(got >= 8, `expected >=8 frames, read ${got}`);

  // Consumer refcount: a second consumer, then drop back to one (still live).
  P.connect(id);
  assert.equal(P.consumers(id), 2);
  assert.equal(P.disconnect(id), 1);
  const stillLive = reader.readInto(rh, dest, lastSeq);
  if (stillLive && !isClosed(stillLive)) lastSeq = stillLive.seq;

  // Symmetric close: drain remaining frames, then observe explicit CLOSED.
  P.close(id);
  let sawClosed = false;
  const closeDeadline = Date.now() + 2000;
  while (Date.now() < closeDeadline) {
    const r = reader.readInto(rh, dest, lastSeq);
    if (isClosed(r)) {
      sawClosed = true;
      break;
    }
    if (r) lastSeq = r.seq;
    await sleep(2);
  }
  assert(sawClosed, "consumer must observe explicit CLOSED after close()");

  reader.close(rh);
  P.drop(id);
}

cleanup();
console.log("pipe integration tests passed.");
