// `@src/profiler/workload-view` — the pure snapshot→view-model transform
// behind the profiler's uniform workload sections (C-7, workload-metering.md
// §4). Pure data-in/data-out: time comes from the snapshots' own
// `window.snapshotAt`, so no fake timers are needed.

import { describe, expect, it } from "vitest";
import type { WorkloadSnapshot } from "@lib/orchestrator/contracts";
import {
  UTILIZATION_HIGH,
  UTILIZATION_WARN,
  utilizationLevel,
  workloadRows,
} from "@src/profiler/workload-view";

function snap(over: Partial<WorkloadSnapshot> = {}): WorkloadSnapshot {
  return {
    name: "w",
    window: { startedAt: 0, snapshotAt: 1000, uptimeMs: 1000 },
    utilization: 0.5,
    busyMs: 500,
    inputs: {},
    outputs: {},
    drops: { total: 0, ratePerSec: 0, byReason: {} },
    ...over,
  };
}

describe("workloadRows — fallback (first tick, no previous snapshot)", () => {
  it("uses the meter's own cumulative utilization and rates, flagged interval=false", () => {
    const rows = workloadRows(
      {
        w: snap({
          utilization: 0.25,
          inputs: { camera: { count: 30, ratePerSec: 30 } },
          outputs: { shm: { count: 29, ratePerSec: 29 } },
        }),
      },
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].interval).toBe(false);
    expect(rows[0].utilization).toBe(0.25);
    expect(rows[0].inputs).toEqual([
      { name: "camera", count: 30, ratePerSec: 30, maxIntervalMs: 0, stalled: false },
    ]);
    expect(rows[0].outputs).toEqual([
      { name: "shm", count: 29, ratePerSec: 29, maxIntervalMs: 0, stalled: false },
    ]);
  });

  it("clamps a defensive out-of-range cumulative utilization into [0, 1]", () => {
    const rows = workloadRows({ w: snap({ utilization: 1.7 }) }, null);
    expect(rows[0].utilization).toBe(1);
  });
});

describe("workloadRows — interval diff against the previous tick", () => {
  const prev = {
    w: snap({
      window: { startedAt: 0, snapshotAt: 10_000, uptimeMs: 10_000 },
      busyMs: 9000, // 90% cumulative — but the *last tick* is what we want
      utilization: 0.9,
      inputs: { camera: { count: 100, ratePerSec: 10 } },
      outputs: { shm: { count: 90, ratePerSec: 9 } },
      drops: { total: 10, ratePerSec: 1, byReason: { coalesced: 10 } },
    }),
  };
  const cur = {
    w: snap({
      window: { startedAt: 0, snapshotAt: 12_000, uptimeMs: 12_000 },
      busyMs: 9200, // +200ms busy over a 2000ms tick → 10% interval
      utilization: 9200 / 12_000,
      inputs: { camera: { count: 160, ratePerSec: 160 / 12 } },
      outputs: { shm: { count: 148, ratePerSec: 148 / 12 } },
      drops: { total: 12, ratePerSec: 1, byReason: { coalesced: 11, backpressure: 1 } },
    }),
  };

  it("derives interval utilization and per-name rates from the count/busy deltas", () => {
    const [row] = workloadRows(cur, prev);
    expect(row.interval).toBe(true);
    expect(row.utilization).toBeCloseTo(0.1, 5); // 200ms / 2000ms, not 76% cumulative
    expect(row.inputs).toEqual([
      { name: "camera", count: 160, ratePerSec: 30, maxIntervalMs: 0, stalled: false }, // 60 / 2s
    ]);
    expect(row.outputs).toEqual([
      { name: "shm", count: 148, ratePerSec: 29, maxIntervalMs: 0, stalled: false }, // 58 / 2s
    ]);
    expect(row.drops.ratePerSec).toBeCloseTo(1, 5); // 2 drops / 2s
    expect(row.drops.total).toBe(12);
  });

  it("sorts drop reasons by count descending", () => {
    const [row] = workloadRows(cur, prev);
    expect(row.drops.byReason).toEqual([
      { reason: "coalesced", count: 11 },
      { reason: "backpressure", count: 1 },
    ]);
  });

  it("treats an input name that first appears mid-flight as diffed against 0", () => {
    const cur2 = {
      w: snap({
        window: { startedAt: 0, snapshotAt: 12_000, uptimeMs: 12_000 },
        inputs: { camera: { count: 160, ratePerSec: 0 }, late: { count: 4, ratePerSec: 0 } },
      }),
    };
    const [row] = workloadRows(cur2, prev);
    expect(row.inputs.find((r) => r.name === "late")).toEqual({
      name: "late",
      count: 4,
      ratePerSec: 2, // 4 / 2s — its whole count landed within the window
      maxIntervalMs: 0,
      stalled: false,
    });
  });
});

describe("workloadRows — registration boundaries", () => {
  it("falls back to cumulative when the meter re-registered (startedAt changed)", () => {
    const prev = { w: snap({ window: { startedAt: 0, snapshotAt: 5000, uptimeMs: 5000 }, busyMs: 4000 }) };
    const cur = {
      w: snap({
        window: { startedAt: 6000, snapshotAt: 7000, uptimeMs: 1000 }, // fresh registration
        busyMs: 100,
        utilization: 0.1,
      }),
    };
    const [row] = workloadRows(cur, prev);
    expect(row.interval).toBe(false); // diffing across the reset would go negative
    expect(row.utilization).toBeCloseTo(0.1, 5);
  });

  it("falls back to cumulative when no wall-clock time elapsed between ticks", () => {
    const same = { w: snap() };
    const [row] = workloadRows(same, same);
    expect(row.interval).toBe(false);
    expect(row.utilization).toBe(0.5);
  });

  it("drops disposed workloads and keeps rows sorted by name", () => {
    const prev = { gone: snap({ name: "gone" }), b: snap({ name: "b" }) };
    const cur = { b: snap({ name: "b" }), a: snap({ name: "a" }) };
    const rows = workloadRows(cur, prev);
    expect(rows.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("clamps a negative delta (counter anomaly) to a zero rate instead of going negative", () => {
    const prev = { w: snap({ inputs: { camera: { count: 50, ratePerSec: 5 } } }) };
    const cur = {
      w: snap({
        window: { startedAt: 0, snapshotAt: 2000, uptimeMs: 2000 },
        inputs: { camera: { count: 40, ratePerSec: 4 } },
      }),
    };
    const [row] = workloadRows(cur, prev);
    expect(row.inputs[0].ratePerSec).toBe(0);
  });
});

describe("utilizationLevel — the meter's status tint thresholds", () => {
  it("maps utilization to ok/warn/high at the exported thresholds", () => {
    expect(utilizationLevel(0)).toBe("ok");
    expect(utilizationLevel(UTILIZATION_WARN - 0.001)).toBe("ok");
    expect(utilizationLevel(UTILIZATION_WARN)).toBe("warn");
    expect(utilizationLevel(UTILIZATION_HIGH - 0.001)).toBe("warn");
    expect(utilizationLevel(UTILIZATION_HIGH)).toBe("high");
    expect(utilizationLevel(1)).toBe("high");
  });
});

describe("workloadRows — C-18 maxIntervalMs + stall highlight", () => {
  // maxIntervalMs rides the snapshot at runtime; the A-owned counter type does
  // not carry it yet (handoff logged), so cast the mock counters here.
  const withInterval = (
    v: Record<string, { count: number; ratePerSec: number; maxIntervalMs: number }>,
  ) => v as unknown as WorkloadSnapshot["inputs"];

  it("passes maxIntervalMs through and flags a stall (gap > 2× nominal period)", () => {
    const [row] = workloadRows(
      {
        w: snap({
          // 50/s → 20 ms period → 2× = 40 ms. 60 ms gap stalls; 25 ms is healthy.
          inputs: withInterval({ cam: { count: 100, ratePerSec: 50, maxIntervalMs: 60 } }),
          outputs: withInterval({ shm: { count: 100, ratePerSec: 50, maxIntervalMs: 25 } }),
        }),
      },
      null,
    );
    expect(row.inputs[0]).toMatchObject({ maxIntervalMs: 60, stalled: true });
    expect(row.outputs[0]).toMatchObject({ maxIntervalMs: 25, stalled: false });
  });

  it("never flags a zero-rate stream (undefined nominal period) as stalled", () => {
    const [row] = workloadRows(
      { w: snap({ inputs: withInterval({ idle: { count: 0, ratePerSec: 0, maxIntervalMs: 5000 } }) }) },
      null,
    );
    expect(row.inputs[0].stalled).toBe(false);
  });
});
