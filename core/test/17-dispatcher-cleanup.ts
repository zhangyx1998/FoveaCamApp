// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 real-1f B-21 regression: `cleanup()` (orchestrator process-quit) must NOT
// hang. Root cause (B-20 finding #2): `Dispatcher::~Context` spun
// `while(!closed) uv_run(async.loop, UV_RUN_NOWAIT)` to close its uv_async
// handle; when `cleanup()` is reached from inside the uv loop (a module
// top-level `await` resumes inside `uv_run`), that nested `uv_run` never fires
// the close callback → infinite hang → the orchestrator gets force-killed on
// quit. Fixed (B-21 option a): the uv_async lives in a heap holder that
// OUTLIVES Context; `~Context` calls `uv_close(&h->async, close_cb)` and
// RETURNS (no nested uv_run); `close_cb` frees the holder on the owning loop.
//
// This reproduces the scenario that hung (fake camera → converter thread →
// read → `cleanup()`), PLUS a Dispatcher with a PENDING FUTURE at cleanup (a
// KCF `for await` still open — the `~Context` "active references" path). If
// `cleanup()` returned, the MARKER prints and the process exits 0; pre-fix it
// hangs (no MARKER → the sweep's per-test timeout fails it).
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/17-dispatcher-cleanup.ts

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, Tracker, __origin__, cleanup } from "core";

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(join(dirname(__origin__), `${prefix}-shm-reader.node`)) as {
  open(seg: string): object;
  readInto(h: object, dest: ArrayBuffer, lastSeq: bigint): { seq: bigint; closed?: undefined } | { closed: true } | null;
  close(h: object): void;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = Pipe as any, A = Aravis as any, T = Tracker as any;

A.enableFakeCamera();
const camera = (await A.Camera.list())[0];
const [height, width] = (await camera.grab(2_000_000)).raw.shape as [number, number];
const bytes = width * height * 4;

// --- a converter thread (the hang scenario) ---------------------------------
const id = "disp:pipe";
P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width, height, channels: 4, stride: width * 4, bytesPerFrame: bytes, ringDepth: 4 });
A.attachCameraPipe(camera, id);
const rh = reader.open(P.connect(id).shmName);
const dest = new ArrayBuffer(bytes);
let got = 0, lastSeq = 0n;
const dl = Date.now() + 1500;
while (got < 3 && Date.now() < dl) {
  const r = reader.readInto(rh, dest, lastSeq);
  if (r && !r.closed) { got++; lastSeq = r.seq; } else await sleep(5);
}
assert(got >= 3, `converter produced frames (${got})`);

// --- BONUS: a KCF `for await` left OPEN → a Dispatcher with a PENDING FUTURE --
// (the `~Context` "destroyed with active references" path). Deliberately not
// awaited/released; cleanup() must still not hang on the pending future.
const tracker = T.createTracker(camera);
tracker.arm({ x: Math.floor(width / 3), y: Math.floor(height / 3), width: 96, height: 96 });
let kcf = 0;
const kcfLoop = (async () => {
  try {
    for await (const _r of tracker as AsyncIterable<unknown>) {
      kcf++;
      if (kcf > 100000) break; // never — the loop is torn down by cleanup()
    }
  } catch { /* the iterator is destroyed by cleanup(); expected */ }
})();
void kcfLoop;
await sleep(600); // let KCF produce + leave a next() Future pending

// Detach the converter (NOT a CoreObject — it lives in B's pipe registry, so it
// won't be freed by cleanup(); leaving it attached would leak its Arv ref).
reader.close(rh);
P.disconnect(id);
A.detachCameraPipe(id);
P.close(id);
P.drop(id);

// THE moment of truth: cleanup() with a live Dispatcher (a KCF next() Future
// still pending) + the fake camera. Pre-fix this hung in `Dispatcher::~Context`.
console.error(`[17] calling cleanup() — converter frames=${got}, kcf=${kcf}, KCF iterator still open`);
cleanup();
console.log("17-dispatcher-cleanup: cleanup() RETURNED cleanly (no hang) — Dispatcher teardown fixed.");
process.exit(0); // marker printed → cleanup did not hang → clean exit
