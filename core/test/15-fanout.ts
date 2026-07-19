// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// With the registry JS view-tap loop
// GONE, `camera.stream` fans to multiple free-running native consumers as
// concurrent `Stream`-base subscribers, AND an ORDERLY vision-session teardown
// tears them all down cleanly (this is the multi-window-switch drain path).
//
// Drives THREE consumers at once on one fake camera:
//   - the ConverterStream (camera → BGRA pipe, read via the reader addon),
//   - the marker `detector.stream` (native detection stream), and
//   - the KcfTrackerStream (createTracker).
// Then tears down IN ORDER — stop the loops → detach the converter → release the
// tracker/detector/camera CoreObjects — which drops every Arv::Stream/Camera
// RefCount reference and joins every thread, so the process EXITS NATURALLY
// (exit 0) with NO `cleanup()`, no hang, and no "RootReference destroyed with
// non-zero reference" segfault (which occurs when tearing down via
// `cleanup()`/`process.exit` WITHOUT the orderly release).
// NO hardware (fake camera). Run: /opt/homebrew/bin/node core/test/15-fanout.ts

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, Vision, Tracker, __origin__ } from "core";

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(join(dirname(__origin__), `${prefix}-shm-reader.node`)) as {
  open(seg: string): object;
  readInto(h: object, dest: ArrayBuffer, lastSeq: bigint): { seq: bigint; closed?: undefined } | { closed: true } | null;
  close(h: object): void;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = Pipe as any, A = Aravis as any, V = Vision as any, T = Tracker as any;

A.enableFakeCamera();
const camera = (await A.Camera.list())[0];
const [height, width] = (await camera.grab(2_000_000)).raw.shape as [number, number];

let stop = false, converterFrames = 0, detectorTicks = 0, kcfResults = 0;

// --- consumer 1: converter → BGRA pipe, read back via the reader ------
const pipeId = "fan:pipe";
const bytes = width * height * 4;
P.advertise({ id: pipeId, pixelFormat: "BGRA8", dtype: "U8", width, height, channels: 4, stride: width * 4, bytesPerFrame: bytes, ringDepth: 4 });
A.attachCameraPipe(camera, pipeId);
const rh = reader.open(P.connect(pipeId).shmName);
const dest = new ArrayBuffer(bytes);
const converterLoop = (async () => {
  let lastSeq = 0n;
  while (!stop) {
    const r = reader.readInto(rh, dest, lastSeq);
    if (r && !r.closed) { converterFrames++; lastSeq = r.seq; } else await sleep(3);
  }
})();

// --- consumer 2: native marker detector stream -------------------------------
const detector = new V.MarkerDetector("4X4_50");
const detStream = detector.stream(camera.stream, 1.0);
const detectorLoop = (async () => {
  for await (const d of detStream as AsyncIterable<unknown>) {
    if (d) detectorTicks++;
    if (stop) break;
  }
})();

// --- consumer 3: KCF tracker thread ----------------------------------
const tracker = T.createTracker(camera);
tracker.arm({ x: Math.floor(width / 3), y: Math.floor(height / 3), width: 96, height: 96 });
const kcfLoop = (async () => {
  for await (const _r of tracker as AsyncIterable<unknown>) {
    kcfResults++;
    if (stop) break;
  }
})();

// Let all three fan off the one camera stream concurrently.
await sleep(1500);
assert(converterFrames >= 3, `converter fanned frames (${converterFrames})`);
assert(detectorTicks >= 3, `detector fanned detections (${detectorTicks})`);
assert(kcfResults >= 3, `KCF fanned results (${kcfResults})`);
console.log(`15-fanout: fan-out OK — converter=${converterFrames} detector=${detectorTicks} kcf=${kcfResults}`);

// --- ORDERLY teardown (the vision-session-close / window-switch drain path) ---
stop = true;
await Promise.race([Promise.allSettled([converterLoop, detectorLoop, kcfLoop]), sleep(3000)]);
reader.close(rh);
P.disconnect(pipeId);
A.detachCameraPipe(pipeId); // drops the ConverterStream (join) + its Arv::Stream ref
P.close(pipeId);
P.drop(pipeId);
tracker.release(); // drops KcfTrackerStream (join) + its Arv::Stream ref
detStream.release(); // the detector's Stream<MarkerDetectResults> holds the camera.stream ref
camera.release(); // drops the Camera/Stream CoreObject; last Arv::Stream ref → destroyed

// Every reference dropped + every thread joined → the event loop empties and the
// process EXITS NATURALLY. NO cleanup(), NO process.exit — a clean exit 0 here
// IS the proof of clean multi-subscriber teardown.
console.log("15-fanout: orderly teardown complete — exiting naturally (no cleanup/process.exit).");
