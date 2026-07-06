// `@orchestrator/frame-worker` — PB3 A-5's shared latest-wins processing gate.
// Covers the contract the registry's camera loop actually depends on: `submit()`
// must return fast (never invoke `process` synchronously), overlapping frames
// while busy must coalesce to only the latest, and `cancel()` must stop a
// scheduled-but-not-yet-run frame from being processed later (the stale-
// completion guard for a fast idle→reactivate cycle).

import { describe, expect, it } from "vitest";
import { createFrameWorker } from "@orchestrator/frame-worker";

const tick = () => new Promise<void>((r) => setImmediate(r));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createFrameWorker", () => {
  it("submit() copies synchronously but never calls process synchronously", () => {
    let copies = 0;
    let processed = 0;
    const worker = createFrameWorker<{ n: number }, number>({
      copy: (v) => {
        copies++;
        return v.n;
      },
      process: () => {
        processed++;
      },
    });
    const tap = { n: 5 };
    worker.submit(tap);
    expect(copies).toBe(1); // copy runs inline — copy-before-await
    expect(processed).toBe(0); // process is deferred, not inline
    tap.n = 999; // mutate the "tap buffer" after submit — copy must not see this
  });

  it("processes the submitted value on a later turn", async () => {
    const seen: number[] = [];
    const worker = createFrameWorker<number, number>({
      copy: (v) => v,
      process: (v) => {
        seen.push(v);
      },
    });
    worker.submit(1);
    await tick();
    expect(seen).toEqual([1]);
  });

  it("coalesces frames that arrive while busy — only the latest is processed", async () => {
    const seen: number[] = [];
    const gate = deferred<void>();
    let calls = 0;
    const worker = createFrameWorker<number, number>({
      copy: (v) => v,
      process: async (v) => {
        calls++;
        if (calls === 1) await gate.promise; // hold the first run open
        seen.push(v);
      },
    });
    worker.submit(1);
    await tick(); // let the first run start (now awaiting the gate)
    worker.submit(2);
    worker.submit(3); // 2 and 3 arrive while busy — only the latest (3) survives
    expect(worker.busy).toBe(true);
    gate.resolve();
    await tick();
    await tick();
    expect(seen).toEqual([1, 3]);
    expect(calls).toBe(2);
  });

  it("goes idle (busy=false) once the queue drains", async () => {
    const worker = createFrameWorker<number, number>({
      copy: (v) => v,
      process: () => {},
    });
    worker.submit(1);
    expect(worker.busy).toBe(true);
    await tick();
    await tick();
    expect(worker.busy).toBe(false);
  });

  it("cancel() drops a scheduled-but-not-yet-run frame without processing it", async () => {
    const seen: number[] = [];
    const worker = createFrameWorker<number, number>({
      copy: (v) => v,
      process: (v) => {
        seen.push(v);
      },
    });
    worker.submit(1);
    worker.cancel(); // simulates idle landing in the submit→process gap
    await tick();
    await tick();
    expect(seen).toEqual([]);
    expect(worker.busy).toBe(false);
  });

  it("cancel() mid-run doesn't stop future submits from processing normally", async () => {
    const seen: number[] = [];
    const gate = deferred<void>();
    let calls = 0;
    const worker = createFrameWorker<number, number>({
      copy: (v) => v,
      process: async (v) => {
        calls++;
        if (calls === 1) await gate.promise;
        seen.push(v);
      },
    });
    worker.submit(1);
    await tick(); // first run in flight, awaiting the gate
    worker.cancel(); // invalidate the in-flight run's follow-through
    worker.submit(2); // a fresh submit after cancel — must still work
    gate.resolve(); // let the (now-stale) first run's process() body finish
    await tick();
    await tick();
    await tick();
    // The first run's body still executes to completion (can't interrupt a
    // synchronous/in-flight call) — but the worker must still pick up and
    // correctly process the fresh post-cancel submission.
    expect(seen).toEqual([1, 2]);
    expect(calls).toBe(2);
  });
});
