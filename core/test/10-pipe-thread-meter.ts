// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 real-1c (C-19) — producer/publisher SHM write OFF the JS loop + the
// native ThreadMeter probe. A driving thread (SyntheticProducer) feeds frames
// → the publisher seqlock-writes SHM on that thread → a reader-addon consumer
// reads them; the native meter records the producer arrival intervals and the
// orchestrator PROBES the metric block out-of-loop. Inject a stall → the probed
// `maxIntervalMs` spikes. Run UNSANDBOXED: /opt/homebrew/bin/node <file>.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Pipe, __origin__, cleanup } from "core";

type ReaderHandle = object;
type FrameResult = { seq: bigint; gen: number; retries: number; meta: { tCapture: number } };
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

type Snapshot = {
  name: string;
  window: { startedAt: number; snapshotAt: number; uptimeMs: number };
  utilization: number;
  inputs: Record<string, { count: number; ratePerSec: number; maxIntervalMs: number }>;
  outputs: Record<string, { count: number; ratePerSec: number; maxIntervalMs: number }>;
};
const P = Pipe as unknown as {
  advertise(spec: Record<string, unknown>): void;
  connect(id: string): { shmName: string };
  attachSynthetic(id: string, fps: number, seed: number): void;
  injectStall(id: string, ms: number): void;
  probe(id: string): Snapshot;
  close(id: string): void;
  drop(id: string): void;
};

{
  const id = "meter:mono8";
  const width = 8;
  const height = 6;
  const channels = 1;
  const bytesPerFrame = width * height * channels; // 48
  const seed = 30;

  P.advertise({
    id, pixelFormat: "Mono8", dtype: "U8", width, height, channels,
    stride: width * channels, bytesPerFrame, ringDepth: 4,
  });
  P.attachSynthetic(id, 200, seed); // ~5 ms period on its own thread
  const handle = P.connect(id);

  // Frames reach the consumer — the seqlock write ran on the producer thread,
  // never the JS loop.
  const rh = reader.open(handle.shmName);
  const dest = new ArrayBuffer(bytesPerFrame);
  let lastSeq = 0n;
  let got = 0;
  const deadline = Date.now() + 3000;
  while (got < 10 && Date.now() < deadline) {
    const r = reader.readInto(rh, dest, lastSeq);
    if (r && !isClosed(r)) {
      assert(r.seq > lastSeq, "seq advances");
      lastSeq = r.seq;
      assert.equal(new Uint8Array(dest)[0], (seed + Number(r.meta.tCapture)) & 0xff);
      got++;
    } else {
      await sleep(2);
    }
  }
  assert(got >= 10, `frames flowed off-thread, got ${got}`);

  // Probe the native meter: steady stream → maxIntervalMs near the period.
  const steady = P.probe(id);
  assert.equal(steady.name, `pipe:${id}`);
  assert(steady.inputs.frame.count > 0, "meter counted arrivals");
  assert(steady.inputs.frame.ratePerSec > 0, "meter derived a rate");
  const steadyMax = steady.inputs.frame.maxIntervalMs;
  assert(steadyMax < 100, `steady maxIntervalMs ~period, got ${steadyMax}`);

  // Inject a producer stall → the probed maxIntervalMs spikes (the milestone
  // diagnostic: a producer freeze is now visible out-of-loop).
  P.injectStall(id, 200);
  await sleep(300); // let the stall land + the next arrival close the gap
  const stalled = P.probe(id);
  const stalledMax = stalled.inputs.frame.maxIntervalMs;
  assert(stalledMax >= 150, `stall spikes maxIntervalMs, got ${stalledMax}`);
  assert(stalledMax > steadyMax, "stall is distinguishable from steady");

  reader.close(rh);
  P.close(id);
  P.drop(id);
}

cleanup();
console.log("pipe thread-meter tests passed.");
