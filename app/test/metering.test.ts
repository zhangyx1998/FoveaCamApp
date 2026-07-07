// `@orchestrator/metering` — the Workload meter core (docs/refactor/
// workload-metering.md §2). Covers the math (utilization, rates, drops) with
// fake timers so results are exact, plus one integration-style pass through
// a fake loop-like workload exercising the full ingest/begin/end/emit/drop
// cycle the way a real citizen (registry preview loop, frame-worker gate,
// recorder worker) would.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allWorkloadSnapshots,
  registerWorkload,
  workloadsSnapshot,
  workloadSnapshot,
} from "@orchestrator/metering";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registerWorkload — counters and rates", () => {
  it("pre-seeds declared inputs/outputs at 0 and derives rates from cumulative uptime", () => {
    const w = registerWorkload("test:counters-1", {
      inputs: ["camera"],
      outputs: ["shm", "view"],
    });
    const seeded = workloadSnapshot("test:counters-1")!;
    expect(seeded.inputs).toEqual({ camera: { count: 0, ratePerSec: 0 } });
    expect(seeded.outputs).toEqual({
      shm: { count: 0, ratePerSec: 0 },
      view: { count: 0, ratePerSec: 0 },
    });
    expect(seeded.drops).toEqual({ total: 0, ratePerSec: 0, byReason: {} });

    vi.setSystemTime(2000); // 2s of uptime
    w.ingest("camera", 4);
    w.emit("shm", 2);
    w.emit("view", 1);

    const snap = workloadSnapshot("test:counters-1")!;
    expect(snap.window).toEqual({ startedAt: 0, snapshotAt: 2000, uptimeMs: 2000 });
    expect(snap.inputs.camera).toEqual({ count: 4, ratePerSec: 2 });
    expect(snap.outputs.shm).toEqual({ count: 2, ratePerSec: 1 });
    expect(snap.outputs.view).toEqual({ count: 1, ratePerSec: 0.5 });

    w.dispose();
  });

  it("accepts an undeclared name (tracked, just not pre-seeded)", () => {
    const w = registerWorkload("test:counters-2", { inputs: [], outputs: [] });
    w.ingest("surprise");
    const snap = workloadSnapshot("test:counters-2")!;
    expect(snap.inputs.surprise.count).toBe(1);
    w.dispose();
  });

  it("buckets drops per reason and totals them", () => {
    const w = registerWorkload("test:drops-1", { inputs: [], outputs: [] });
    w.drop("coalesced");
    w.drop("coalesced");
    w.drop("backpressure", 3);
    w.drop(); // defaults to "unspecified"
    const snap = workloadSnapshot("test:drops-1")!;
    expect(snap.drops.byReason).toEqual({ coalesced: 2, backpressure: 3, unspecified: 1 });
    expect(snap.drops.total).toBe(6);
    w.dispose();
  });
});

describe("registerWorkload — utilization", () => {
  it("computes busy-time fraction of wall-clock uptime from begin()/end() pairs", () => {
    const w = registerWorkload("test:util-1", { inputs: [], outputs: [] });
    // 100ms busy out of the first 1000ms.
    w.begin();
    vi.setSystemTime(100);
    w.end();
    vi.setSystemTime(1000);
    expect(workloadSnapshot("test:util-1")!.utilization).toBeCloseTo(0.1, 5);
    expect(workloadSnapshot("test:util-1")!.busyMs).toBe(100);

    // Another 400ms busy span, still within the same cumulative window.
    w.begin();
    vi.setSystemTime(1400);
    w.end();
    expect(workloadSnapshot("test:util-1")!.busyMs).toBe(500);
    expect(workloadSnapshot("test:util-1")!.utilization).toBeCloseTo(500 / 1400, 5);
    w.dispose();
  });

  it("counts a currently-open span up to the snapshot time (mid-iteration read)", () => {
    const w = registerWorkload("test:util-2", { inputs: [], outputs: [] });
    w.begin();
    vi.setSystemTime(300);
    const snap = workloadSnapshot("test:util-2")!;
    expect(snap.busyMs).toBe(300); // open span folded in, not stuck at 0
    expect(snap.utilization).toBeCloseTo(1, 5);
    w.end();
    w.dispose();
  });

  it("begin() is idempotent while already open — a missed end() can't corrupt the span", () => {
    const w = registerWorkload("test:util-3", { inputs: [], outputs: [] });
    w.begin();
    vi.setSystemTime(50);
    w.begin(); // no-op: span already open since t=0
    vi.setSystemTime(200);
    w.end();
    expect(workloadSnapshot("test:util-3")!.busyMs).toBe(200); // not 200+150
    w.dispose();
  });

  it("clamps utilization to 1 even if busyMs exceeds uptime (defensive)", () => {
    const w = registerWorkload("test:util-4", { inputs: [], outputs: [] });
    w.begin();
    vi.setSystemTime(5000);
    w.end();
    vi.setSystemTime(5001); // uptime just barely ahead of busyMs
    expect(workloadSnapshot("test:util-4")!.utilization).toBeLessThanOrEqual(1);
    w.dispose();
  });
});

describe("registerWorkload — measure()", () => {
  it("wraps a synchronous function and folds its duration into busyMs", () => {
    const w = registerWorkload("test:measure-1", { inputs: [], outputs: [] });
    const result = w.measure(() => {
      vi.setSystemTime(42);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(workloadSnapshot("test:measure-1")!.busyMs).toBe(42);
    w.dispose();
  });

  it("keeps the span open until a returned Promise settles", async () => {
    const w = registerWorkload("test:measure-2", { inputs: [], outputs: [] });
    let resolveFn!: () => void;
    const gate = new Promise<void>((r) => (resolveFn = r));
    const p = w.measure(async () => {
      await gate;
    });
    vi.setSystemTime(75);
    expect(workloadSnapshot("test:measure-2")!.busyMs).toBe(75); // still open, counts live
    resolveFn();
    await p;
    expect(workloadSnapshot("test:measure-2")!.busyMs).toBe(75); // closed at the same instant
    w.dispose();
  });

  it("still closes the span and rethrows when fn() throws synchronously", () => {
    const w = registerWorkload("test:measure-3", { inputs: [], outputs: [] });
    expect(() =>
      w.measure(() => {
        vi.setSystemTime(10);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // Span closed (not left open) — a later begin/end pair measures cleanly.
    w.begin();
    vi.setSystemTime(30);
    w.end();
    expect(workloadSnapshot("test:measure-3")!.busyMs).toBe(30); // 10 (thrown span) + 20
    w.dispose();
  });
});

describe("registerWorkload — dispose and re-registration", () => {
  it("keeps the old allWorkloadSnapshots export as an alias during C-P10", () => {
    expect(allWorkloadSnapshots).toBe(workloadsSnapshot);
  });

  it("dispose() removes the workload from allWorkloadSnapshots() and is idempotent", () => {
    const w = registerWorkload("test:dispose-1", { inputs: [], outputs: [] });
    expect(workloadsSnapshot()["test:dispose-1"]).toBeDefined();
    w.dispose();
    expect(workloadsSnapshot()["test:dispose-1"]).toBeUndefined();
    expect(() => w.dispose()).not.toThrow();
  });

  it("every handle method is a safe no-op after dispose() — meters observe, never gate", () => {
    const w = registerWorkload("test:dispose-2", { inputs: [], outputs: [] });
    w.dispose();
    expect(() => {
      w.ingest("x");
      w.emit("y");
      w.drop("z");
      w.begin();
      w.end();
    }).not.toThrow();
    // measure() must still invoke fn() and return/propagate its outcome —
    // the meter never gates the actual work, disposed or not.
    let ran = false;
    const result = w.measure(() => {
      ran = true;
      return 7;
    });
    expect(ran).toBe(true);
    expect(result).toBe(7);
  });

  it("re-registering a live name warns but replaces the entry instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = registerWorkload("test:reregister-1", { inputs: [], outputs: [] });
    first.ingest("a", 5);
    const second = registerWorkload("test:reregister-1", { inputs: [], outputs: [] });
    expect(warn).toHaveBeenCalledOnce();
    // Fresh window — the stale handle's counts are gone.
    expect(workloadSnapshot("test:reregister-1")!.inputs).toEqual({});
    second.dispose();
    warn.mockRestore();
  });
});

describe("integration: a fake loop-like workload", () => {
  it("models a producer/consumer cycle end to end — ingest, busy work, emit, and a coalesced drop", async () => {
    const workload = registerWorkload("test:integration-1", {
      inputs: ["frame"],
      outputs: ["published"],
    });

    // A tiny stand-in for a registry-style loop: `submit` copies input
    // synchronously (ingest), `drain` does the "busy" work and emits.
    let pending: number | null = null;
    let busy = false;
    function submit(frame: number) {
      const coalesced = busy && pending !== null;
      pending = frame;
      workload.ingest("frame");
      if (coalesced) workload.drop("coalesced");
      if (busy) return;
      busy = true;
    }
    async function drain(workMs: number) {
      const value = pending;
      pending = null;
      await workload.measure(async () => {
        vi.setSystemTime(Number(vi.getMockedSystemTime()) + workMs);
      });
      if (value !== null) workload.emit("published");
      busy = false;
    }

    submit(1);
    await drain(10); // 10ms busy for frame 1

    submit(2);
    submit(3); // arrives while "busy" from this test's perspective — coalesces
    await drain(5); // 5ms busy for frame 3 (2 was dropped)

    vi.setSystemTime(1000); // advance wall clock well past the busy work

    const snap = workloadSnapshot("test:integration-1")!;
    expect(snap.inputs.frame.count).toBe(3);
    expect(snap.outputs.published.count).toBe(2);
    expect(snap.drops.byReason.coalesced).toBe(1);
    expect(snap.busyMs).toBe(15);
    expect(snap.window.uptimeMs).toBe(1000);
    expect(snap.utilization).toBeCloseTo(15 / 1000, 5);

    workload.dispose();
  });
});
