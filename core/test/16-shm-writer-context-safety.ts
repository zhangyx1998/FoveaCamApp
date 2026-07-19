// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `core.node`'s SHM writer classes must be CONTEXT-SAFE across worker_thread
// teardown — same fix as the reader addon (test 14). `ShmSlotObject`/
// `ShmWriterObject` store their constructors in per-env instance data
// (`SetInstanceData<ShmAddonData>`), NOT a process-global
// `static Napi::FunctionReference`: a process-global would dangle when a
// worker that loaded `core.node` (for core/Vision) terminates, segfaulting the
// MAIN thread's next `Shm.Writer(...).nextSlot()` (`ShmSlotObject::Create`) in V8.
//
// Sequence: main writer OK → worker loads core.node + uses a writer OK →
// worker terminates → MAIN `Shm.Writer().nextSlot()` STILL works.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/16-shm-writer-context-safety.ts

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { Shm, cleanup } from "core";

const S = Shm as unknown as {
  topicKey(t: string): string;
  Writer: new (key: string) => {
    nextSlot(shape: number[], channels: number): {
      debugFillPattern(v: number): void;
      readSnapshot(): Uint8Array;
    };
    publish(meta: { tCapture: number; convertMs?: number }): unknown;
    close(): void;
  };
};

/** Exercises `ShmSlotObject::Create`. */
function useWriter(topic: string, fill: number): number {
  const writer = new S.Writer(S.topicKey(topic));
  const slot = writer.nextSlot([2, 3], 4); // → ShmSlotObject::Create
  slot.debugFillPattern(fill);
  const desc = writer.publish({ tCapture: fill, convertMs: 1 });
  assert(desc, `publish returned a descriptor (${topic})`);
  const snap = slot.readSnapshot();
  writer.close();
  return snap[0];
}

// 1) main writer works before any worker.
assert.equal(useWriter("ctx-writer-1", 11), 11, "main writer (baseline)");

// 2) a worker loads core.node in its OWN env + uses a writer, then terminates.
const worker = new Worker(
  `
    import { parentPort } from "node:worker_threads";
    import { Shm } from "core";
    const w = new Shm.Writer(Shm.topicKey("ctx-writer-worker"));
    w.nextSlot([2, 3], 4).debugFillPattern(22);   // ShmSlotObject::Create in the worker env
    const d = w.publish({ tCapture: 22, convertMs: 0 });
    w.close();
    parentPort.postMessage(!!d);
  `,
  { eval: true },
);
const workerOk = await new Promise((resolve, reject) => {
  worker.on("message", resolve);
  worker.on("error", reject);
});
assert.equal(workerOk, true, "worker used a writer in its own env");
await worker.terminate();

// 3) after the worker's env is torn down, the MAIN writer must still create a slot.
assert.equal(useWriter("ctx-writer-3", 33), 33, "main writer after worker teardown (was a segfault)");

cleanup();
console.log("16-shm-writer-context-safety: ShmSlot/Writer survive worker_thread teardown (per-env instance data).");
