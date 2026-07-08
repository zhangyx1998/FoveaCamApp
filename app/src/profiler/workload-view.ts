// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure snapshot→view-model transform for the profiler's uniform workload
// sections (docs/history/refactor/workload-metering.md §4). Takes the current and
// previous `perfSnapshot.workloads` records (the profiler already polls
// `system.perfSnapshot` at 1 Hz and keeps the previous one for its channel
// rate table — same inputs, no new wire messages) and derives *interval*
// utilization/rates by diffing the two, falling back to the meter's own
// cumulative numbers when there is nothing to diff against.
//
// Why diff at all: `metering.ts`'s snapshot rates are cumulative since
// registration (T10-style — honest, but slow-moving: a registry loop that ran
// all night averages the night in). A live profiler wants "what happened in
// the last poll tick." Both derive from the same counters; this transform
// just chooses the window.
//
// Pure and Vue-free by design (the DoD's testability requirement): time comes
// from each snapshot's own `window.snapshotAt`, never `Date.now()`; inputs
// are plain data; output is plain data. Vue only renders the result.

import type { WorkloadSnapshot } from "@lib/orchestrator/contracts";

export type WorkloadCounterRow = {
  name: string;
  /** Cumulative count since the meter registered. */
  count: number;
  /** Interval rate when a comparable previous snapshot exists, else the
   *  meter's cumulative rate. */
  ratePerSec: number;
  /** C-18 diagnostic: largest inter-arrival interval (ms) over the trailing
   *  10 s. Flat ≈ period → this producer stream is healthy; a spike is a stall. */
  maxIntervalMs: number;
  /** True when `maxIntervalMs` exceeds `STALL_FACTOR` × the stream's nominal
   *  period (from its cumulative rate) — the "obvious bad value" highlight. */
  stalled: boolean;
};

/** A stream whose worst 10 s gap exceeds this multiple of its nominal period is
 *  flagged stalled. ~2× per the C-18 request (a periodic tens-of-ms freeze on a
 *  ~18 ms/55 fps producer trips it). Exported for the unit test to pin. */
export const STALL_FACTOR = 2;

export type WorkloadDropRow = { reason: string; count: number };

export type WorkloadRow = {
  name: string;
  /** Busy fraction [0, 1] — interval-based when diffable, else cumulative. */
  utilization: number;
  /** True when `utilization` (and the rates) came from an interval diff,
   *  false when they're cumulative-since-registration fallbacks. */
  interval: boolean;
  /** Cumulative busy milliseconds and wall-clock uptime, for the sub-label. */
  busyMs: number;
  uptimeMs: number;
  inputs: WorkloadCounterRow[];
  outputs: WorkloadCounterRow[];
  drops: {
    total: number;
    ratePerSec: number;
    /** Sorted by count descending, then reason — worst offender first. */
    byReason: WorkloadDropRow[];
  };
};

/** Utilization thresholds for the meter's status tint. The numeric % is
 *  always printed next to the bar, so the tint is redundant encoding, never
 *  color-alone. Exported for the unit test to pin. */
export const UTILIZATION_WARN = 0.75;
export const UTILIZATION_HIGH = 0.9;

export type UtilizationLevel = "ok" | "warn" | "high";

export function utilizationLevel(utilization: number): UtilizationLevel {
  if (utilization >= UTILIZATION_HIGH) return "high";
  if (utilization >= UTILIZATION_WARN) return "warn";
  return "ok";
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** A previous snapshot is only diffable against the current one if it is the
 *  same registration (same `startedAt` — a dispose/re-register cycle resets
 *  the counters, so diffing across it would go negative) and time actually
 *  advanced between the two. */
function diffable(cur: WorkloadSnapshot, prev: WorkloadSnapshot | undefined): prev is WorkloadSnapshot {
  return (
    prev !== undefined &&
    prev.window.startedAt === cur.window.startedAt &&
    cur.window.snapshotAt > prev.window.snapshotAt
  );
}

// `maxIntervalMs` rides the snapshot at runtime (metering emits it) but the
// A-owned counter TYPE doesn't carry it yet (handoff logged) — read it
// defensively as optional until that lands.
type CounterIn = { count: number; ratePerSec: number; maxIntervalMs?: number };

function counterRows(
  cur: Record<string, CounterIn>,
  prev: Record<string, CounterIn> | null,
  dtSec: number | null,
): WorkloadCounterRow[] {
  return Object.keys(cur)
    .sort()
    .map((name) => {
      const c = cur[name];
      const p = prev?.[name];
      // A name that first appears mid-flight (undeclared inputs are tracked
      // lazily) has no previous count — its whole count landed "recently,"
      // so diffing against an implicit 0 is the honest interval reading.
      const ratePerSec =
        dtSec !== null ? Math.max(0, (c.count - (p?.count ?? 0)) / dtSec) : c.ratePerSec;
      const maxIntervalMs = c.maxIntervalMs ?? 0;
      // Nominal period from the stable CUMULATIVE rate (not the momentary diff,
      // which the stall itself would deflate and hide the highlight).
      const nominalPeriodMs = c.ratePerSec > 0 ? 1000 / c.ratePerSec : Infinity;
      const stalled = maxIntervalMs > STALL_FACTOR * nominalPeriodMs;
      return { name, count: c.count, ratePerSec, maxIntervalMs, stalled };
    });
}

/**
 * The transform. `cur`/`prev` are `perfSnapshot.workloads` from the current
 * and previous poll ticks (`prev` null on the first tick). Workloads present
 * only in `prev` (disposed since) simply drop out; workloads present only in
 * `cur` (fresh) get cumulative fallbacks until the next tick can diff them.
 * Rows sort by name so the section order is stable across polls.
 */
export function workloadRows(
  cur: Record<string, WorkloadSnapshot>,
  prev: Record<string, WorkloadSnapshot> | null,
): WorkloadRow[] {
  return Object.keys(cur)
    .sort()
    .map((name) => {
      const c = cur[name];
      const p = prev?.[name];
      const canDiff = diffable(c, p);
      const dtMs = canDiff ? c.window.snapshotAt - p.window.snapshotAt : null;
      const dtSec = dtMs !== null ? dtMs / 1000 : null;

      const utilization =
        dtMs !== null
          ? clamp01((c.busyMs - p!.busyMs) / dtMs)
          : clamp01(c.utilization);

      const dropTotal = c.drops.total;
      const dropRate =
        dtSec !== null
          ? Math.max(0, (dropTotal - p!.drops.total) / dtSec)
          : c.drops.ratePerSec;
      const byReason = Object.entries(c.drops.byReason)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

      return {
        name,
        utilization,
        interval: dtMs !== null,
        busyMs: c.busyMs,
        uptimeMs: c.window.uptimeMs,
        inputs: counterRows(c.inputs, canDiff ? p.inputs : null, dtSec),
        outputs: counterRows(c.outputs, canDiff ? p.outputs : null, dtSec),
        drops: { total: dropTotal, ratePerSec: dropRate, byReason },
      };
    });
}
