// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Foundation guard for the native spawn architecture, proven end-to-end and
// DECOUPLED from the app kernels so it won't churn as they iterate:
//
//   main: enableFakeCamera → advertise a `camera:<serial>` pipe →
//         attachCameraPipe (the converter thread runs) →
//         Pipe.connect (main brokers the consumer gate → converter produces);
//   WORKER (worker_thread, own V8 env): loads BOTH native addons — the SHM
//         reader AND `core.node` itself (proves core-in-worker context-safety:
//         the addon Init runs in a 2nd env + survives terminate) —
//         then reader.open(shmName) + readInto a few LIVE frames, asserts each
//         is byte-correct BGRA (GRAY→BGRA ⇒ B==G==R, alpha 255), runs a TRIVIAL
//         transform (first-row luma sum — deliberately NOT the app's disparity
//         kernel, so this test stays decoupled from the app protocol), posts results;
//   main: asserts it got N results, then ORDERLY teardown IN ORDER
//         (worker.terminate → disconnect → detachCameraPipe → camera.release) →
//         EXITS NATURALLY (exit 0), zero non-zero-ref / leak warns.
//
// Together this guards: worker_thread spawn + core.node-in-worker +
// reader-from-worker + SHM read of a live converter pipe +
// gate-fires-on-in-process-connect + clean orderly teardown.
// NO hardware (fake camera). Run: /opt/homebrew/bin/node core/test/13-worker-pipe.ts

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, __origin__ } from "core";

const prefix = basename(__origin__, ".node");
const readerPath = join(dirname(__origin__), `${prefix}-shm-reader.node`);
const corePath = __origin__; // the raw core.node — the worker loads it in its own env

const P = Pipe as any, A = Aravis as any;
const N = 5; // frames the worker must read off the live pipe

// --- main: fake camera → converter pipe → broker the consumer gate -----------
A.enableFakeCamera();
const camera = (await A.Camera.list())[0];
assert(camera, "fake camera enumerated");
const probe = await camera.grab(2_000_000);
const [height, width] = probe.raw.shape as [number, number];
probe.release?.();

const serial = String(camera.serial ?? "0");
const id = `camera:${serial}`; // a `camera:<serial>`-style pipe id
const channels = 4; // BGRA8
const bytes = width * height * channels;
const px = width * height;

P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width, height, channels, stride: width * channels, bytesPerFrame: bytes, ringDepth: 4 });
assert.equal(A.attachCameraPipe(camera, id), true, "attachCameraPipe (converter thread runs)");
const { shmName } = P.connect(id); // main brokers → drives the consumer gate → converter produces
assert(typeof shmName === "string" && shmName.length > 0, "broker returned a shm segment name");

// --- worker: load reader + core.node in a fresh env, read the LIVE pipe -------
const code = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const reader = require(workerData.readerPath);
  // Load core.node in THIS worker env too (Init runs in a 2nd env and must
  // survive terminate). Do NOT touch the camera — Aravis is per-process
  // exclusive; loading the addon is the context-safety proof, not using it.
  const core = require(workerData.corePath);
  const coreLoaded = core != null && typeof core === "object" && typeof core.Aravis === "object";

  const h = reader.open(workerData.shmName);
  const dest = new ArrayBuffer(workerData.bytes);
  let lastSeq = 0n, got = 0, bgraOk = true;
  const samples = [];
  const deadline = Date.now() + 6000;
  while (got < workerData.N && Date.now() < deadline) {
    const r = reader.readInto(h, dest, lastSeq);
    if (r && !r.closed) {
      lastSeq = r.seq;
      const b = new Uint8Array(dest);
      // byte-correct BGRA: GRAY→BGRA ⇒ B==G==R per pixel, alpha saturated (sparse sample).
      for (let p = 0; p < workerData.px; p += 997) {
        if (!(b[p*4] === b[p*4+1] && b[p*4+1] === b[p*4+2] && b[p*4+3] === 255)) { bgraOk = false; break; }
      }
      // TRIVIAL transform (decoupled from any app kernel): first-row B-channel luma sum.
      let sum = 0; for (let x = 0; x < workerData.width; x++) sum += b[x*4];
      samples.push(sum >>> 0);
      got++;
    } else { const t = Date.now(); while (Date.now() - t < 3) {} }
  }
  reader.close(h);
  parentPort.postMessage({ got, bgraOk, coreLoaded, samples });
`;
const w = new Worker(code, { eval: true, workerData: { readerPath, corePath, shmName, bytes, N, px, width } });
const result = (await new Promise((resolve, reject) => {
  w.on("message", resolve);
  w.on("error", reject);
})) as { got: number; bgraOk: boolean; coreLoaded: boolean; samples: number[] };

assert.equal(result.coreLoaded, true, "core.node loaded + Init ran in the worker env (B-19b/c)");
assert(result.got >= N, `worker read N live frames off the pipe (got ${result.got}/${N})`);
assert.equal(result.bgraOk, true, "worker frames are byte-correct BGRA (B==G==R, alpha 255)");
assert.equal(result.samples.length, result.got, "one transform result per frame");
console.log(`13-worker-pipe: worker read ${result.got} live BGRA frames + ran core-in-worker safely (samples[0]=${result.samples[0]}).`);

// --- ORDERLY teardown (the test-15 converter-subset release order) -----
await w.terminate(); // worker env torn down — reader + core.node must survive it
P.disconnect(id);
A.detachCameraPipe(id); // drops the ConverterStream (join) + its Arv::Stream ref
P.close(id);
P.drop(id);
camera.release(); // drops the Camera/Stream CoreObject; last Arv::Stream ref → destroyed

// Every reference dropped + every thread joined → the event loop empties and the
// process EXITS NATURALLY (exit 0). No cleanup(), no process.exit — a clean exit
// here IS the proof of the whole spawn+read+teardown architecture.
console.log("13-worker-pipe: orderly teardown complete — exiting naturally (no cleanup/process.exit).");
