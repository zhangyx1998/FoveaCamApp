// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The SHM reader addon must be CONTEXT-SAFE across worker_thread teardown.
// `ReaderObject`'s constructor is stored in per-env instance data
// (SetInstanceData), NOT a process-global `static FunctionReference`: a
// process-global gets overwritten by a worker loading the addon and left
// dangling on the worker's teardown, segfaulting the MAIN thread's next
// `reader.open()` in V8 (EscapableHandleScope, dead Isolate).
//
// Sequence exercised:
//   main read OK → worker loads addon + reads OK → worker terminates →
//   MAIN reader.open()/readInto() STILL works (no segfault, byte-correct).
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/14-reader-context-safety.ts

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, __origin__ } from "core";

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const readerPath = join(dirname(__origin__), `${prefix}-shm-reader.node`);
const reader = require(readerPath) as {
  open(seg: string): object;
  readInto(h: object, dest: ArrayBuffer, lastSeq: bigint): { seq: bigint; closed?: undefined } | { closed: true } | null;
  close(h: object): void;
};

const P = Pipe as unknown as {
  advertise(spec: Record<string, unknown>): void;
  connect(id: string): { shmName: string };
  close(id: string): void;
  drop(id: string): void;
};
const A = Aravis as unknown as { feedTestFrame(id: string, src: string, fill: number): boolean };

function makePipe(id: string, fill: number) {
  const w = 4, h = 4, bytes = w * h * 4;
  P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width: w, height: h, channels: 4, stride: w * 4, bytesPerFrame: bytes, ringDepth: 4 });
  const handle = P.connect(id);
  A.feedTestFrame(id, "Mono8", fill);
  return { shmName: handle.shmName, bytes };
}

function mainRead(shmName: string, bytes: number): number | null {
  const rh = reader.open(shmName); // ← must stay valid after worker teardown
  const dest = new ArrayBuffer(bytes);
  let r = null;
  for (let i = 0; i < 300 && !r; i++) {
    r = reader.readInto(rh, dest, 0n);
    if (!r) { const t = Date.now(); while (Date.now() - t < 2) {} }
  }
  reader.close(rh);
  return r && !r.closed ? new Uint8Array(dest)[0] : null;
}

{
  // 1) main reader works before any worker.
  const p1 = makePipe("ctx:1", 11);
  assert.equal(mainRead(p1.shmName, p1.bytes), 11, "main read (baseline)");
  P.close("ctx:1"); P.drop("ctx:1");

  // 2) a worker loads the addon in its own env + reads, then terminates.
  const p2 = makePipe("ctx:2", 22);
  const code = String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    const rd = require(workerData.readerPath);
    const h = rd.open(workerData.shmName);
    const d = new ArrayBuffer(workerData.bytes);
    let r = null;
    for (let i = 0; i < 300 && !r; i++) { r = rd.readInto(h, d, 0n); if (!r) { const t = Date.now(); while (Date.now() - t < 2) {} } }
    rd.close(h);
    parentPort.postMessage(r && !r.closed ? new Uint8Array(d)[0] : null);
  `;
  const w = new Worker(code, { eval: true, workerData: { readerPath, shmName: p2.shmName, bytes: p2.bytes } });
  const workerByte = await new Promise((resolve, reject) => { w.on("message", resolve); w.on("error", reject); });
  assert.equal(workerByte, 22, "worker read (own env)");
  await w.terminate();
  P.close("ctx:2"); P.drop("ctx:2");

  // 3) after the worker's env is torn down, the MAIN reader must still
  //    open+read a fresh segment.
  const p3 = makePipe("ctx:3", 33);
  assert.equal(mainRead(p3.shmName, p3.bytes), 33, "main read after worker teardown (was a segfault)");
  P.close("ctx:3"); P.drop("ctx:3");
}

console.log("14-reader-context-safety: reader addon survives worker_thread teardown (per-env instance data).");
process.exit(0); // cleanup() hangs in the fake-camera/converter path; not exercised here
