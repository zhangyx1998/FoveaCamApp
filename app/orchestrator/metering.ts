// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Workload metering core: one perf-reporting schema every loop-like unit registers
// once (native probes + recorder worker + JS loops), so nothing hand-grows counters.
// Vue-free (rolling.ts lineage, never renderer-only perf.ts).
// HARD RULE: meters observe, never gate — every WorkloadHandle method is a safe no-op
// after dispose() (measure() still invokes the wrapped fn), so a wiring bug or a stale
// handle can never throw into or change the outcome of the metered path.
// spec: docs/spec/graph.md#metering

import {
  counterRate,
  ratePerSec,
  snapshotWindow,
  type CounterRate,
  type SnapshotWindow,
  type WorkloadSnapshot,
} from "@lib/orchestrator/stats";

/** Declared input/output names for one workload — pre-seeds the snapshot's
 *  counters at 0 so the shape is stable even before any activity (mirrors
 *  `controller`'s zeroed telemetry defaults). */
export interface WorkloadSpec {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

export interface WorkloadHandle {
  /** Count one (or `n`) arrivals on a named input. Unlisted names are
   *  accepted and tracked too — `inputs`/`outputs` in the spec only control
   *  which names are pre-seeded at 0. */
  ingest(input: string, n?: number): void;
  /** Count one (or `n`) emissions to a named output/consumer. */
  emit(output: string, n?: number): void;
  /** Count one (or `n`) dropped/coalesced units, optionally tagged with a
   *  reason (default `"unspecified"`) — bucketed per reason in the snapshot. */
  drop(reason?: string, n?: number): void;
  /** Open a busy span. Idempotent while already open (a caller that forgets
   *  a matching `end()` before calling `begin()` again does not corrupt the
   *  span — the first `begin()` wins). */
  begin(): void;
  /** Close the busy span opened by `begin()`, folding its duration into
   *  cumulative busy time. A no-op if no span is open. */
  end(): void;
  /**
   * `begin()`/`end()` around `fn()` — handles both synchronous return and a
   * returned `Promise` (the span stays open until the promise settles), and
   * always closes the span even if `fn()` throws synchronously. Same
   * semantics as `@lib/util/perf.ts`'s `PerfTimer.measure`, but backed by
   * cumulative busy time instead of a decayed mean.
   */
  measure<T>(fn: () => T): T;
  /** Release this workload — folds any open span into busy time, then
   *  removes it from the process-wide registry (it stops appearing in
   *  `workloadsSnapshot()`). Idempotent. */
  dispose(): void;
}

export interface WorkloadDropSnapshot {
  total: number;
  ratePerSec: number;
  byReason: Record<string, number>;
}

/** Per-stream counter with the C-18 diagnostic: `maxIntervalMs` = the largest
 *  interval (ms) between consecutive events over the trailing 10 s. `CounterRate`
 *  plus one field; assignable to `CounterRate`, so it rides the existing
 *  `WorkloadSnapshot.inputs`/`outputs` shape at runtime even before the A-owned
 *  snapshot TYPES pick the field up (handoff logged). */
export type WorkloadStreamStat = CounterRate & { maxIntervalMs: number };

// C-18 max inter-arrival tracker: 10 × 1 s bins in a ring. Each bin holds the
// max consecutive-event interval seen during that second; the rolling 10 s max
// is the max over the bins. The ring rotates by wall-clock (lazily, at event
// and snapshot time), so a stall ages fully out 10 s after it stops, and an
// in-progress stall is reported live as `now - lastEventTs`.
const BIN_MS = 1000;
const BIN_COUNT = 10;

/** Transport-agnostic descriptor of the max-interval window. This block, the
 *  per-stream `WorkloadStreamStat`, and the whole `WorkloadSnapshot` are PLAIN
 *  DATA by design: when the SHM producer / KCF tracker move into free-running
 *  C++ threads (real-1c / 1d), their native meters populate the exact same
 *  shapes and the orchestrator probes them out-of-loop — the snapshot + profiler
 *  UI stay stable across the JS→C++ move. See the C-18 log for the full schema. */
export const INTERVAL_WINDOW = { bins: BIN_COUNT, binMs: BIN_MS } as const;

interface IntervalRing {
  bins: number[]; // length BIN_COUNT; max interval per 1 s bin
  binStart: number; // wall-clock start of the current bin (bins[cursor])
  cursor: number;
  lastEventTs: number | null;
}

function newRing(now: number): IntervalRing {
  return { bins: new Array(BIN_COUNT).fill(0), binStart: now, cursor: 0, lastEventTs: null };
}

/** Advance the ring to `now`, clearing each newly-entered bin (at most all 10
 *  on a long idle) and keeping `binStart` grid-aligned. O(1) amortized. */
function rotate(ring: IntervalRing, now: number): void {
  const steps = Math.floor((now - ring.binStart) / BIN_MS);
  if (steps <= 0) return;
  const clears = Math.min(steps, BIN_COUNT);
  for (let i = 0; i < clears; i++) {
    ring.cursor = (ring.cursor + 1) % BIN_COUNT;
    ring.bins[ring.cursor] = 0;
  }
  ring.binStart += steps * BIN_MS;
}

function recordEvent(ring: IntervalRing, now: number): void {
  rotate(ring, now);
  if (ring.lastEventTs !== null) {
    const interval = now - ring.lastEventTs;
    if (interval > ring.bins[ring.cursor]) ring.bins[ring.cursor] = interval;
  }
  ring.lastEventTs = now;
}

/** Trailing-10 s max interval: max over the bins, OR the in-progress gap
 *  (`now - lastEventTs`) if a stall is currently open — whichever is larger. */
function ringMax(ring: IntervalRing, now: number): number {
  rotate(ring, now);
  let m = 0;
  for (const b of ring.bins) if (b > m) m = b;
  const inProgress = ring.lastEventTs !== null ? now - ring.lastEventTs : 0;
  return Math.max(m, inProgress);
}

interface WorkloadState {
  name: string;
  createdAtMs: number;
  busyMs: number;
  openSpanAt: number | null;
  inputs: Map<string, number>;
  outputs: Map<string, number>;
  inputIntervals: Map<string, IntervalRing>;
  outputIntervals: Map<string, IntervalRing>;
  drops: Map<string, number>;
  disposed: boolean;
}

const workloads = new Map<string, WorkloadState>();

/**
 * Register a new workload meter. Returns a handle the owning loop/gate calls
 * into from its hot path — see the module doc for the "meters observe, never
 * gate" contract every method upholds.
 *
 * Registering under a name that's already live (not yet `dispose()`d) does
 * not throw — a throw here would risk crashing the caller's activation path
 * (e.g. `registry.ts`'s async camera acquisition), which is exactly the
 * "meters must never gate" rule this module exists to uphold. Instead the
 * stale entry is replaced and a warning logged; fix the double-registration
 * at the call site if you see this warning.
 */
export function registerWorkload(name: string, spec: WorkloadSpec): WorkloadHandle {
  const stale = workloads.get(name);
  if (stale && !stale.disposed) {
    console.warn(
      `[metering] registerWorkload("${name}") called while already registered — replacing`,
    );
  }

  const createdAtMs = Date.now();
  const state: WorkloadState = {
    name,
    createdAtMs,
    busyMs: 0,
    openSpanAt: null,
    inputs: new Map(spec.inputs.map((k) => [k, 0])),
    outputs: new Map(spec.outputs.map((k) => [k, 0])),
    inputIntervals: new Map(spec.inputs.map((k) => [k, newRing(createdAtMs)])),
    outputIntervals: new Map(spec.outputs.map((k) => [k, newRing(createdAtMs)])),
    drops: new Map(),
    disposed: false,
  };
  workloads.set(name, state);

  /** Record an event arrival on a stream's interval ring (lazily creating it
   *  for undeclared names, matching how counters track undeclared names). */
  function tick(rings: Map<string, IntervalRing>, key: string): void {
    const now = Date.now();
    let ring = rings.get(key);
    if (!ring) {
      ring = newRing(now);
      rings.set(key, ring);
    }
    recordEvent(ring, now);
  }

  function ingest(input: string, n = 1): void {
    if (state.disposed) return;
    state.inputs.set(input, (state.inputs.get(input) ?? 0) + n);
    tick(state.inputIntervals, input); // one arrival = one event, regardless of n
  }

  function emit(output: string, n = 1): void {
    if (state.disposed) return;
    state.outputs.set(output, (state.outputs.get(output) ?? 0) + n);
    tick(state.outputIntervals, output);
  }

  function drop(reason = "unspecified", n = 1): void {
    if (state.disposed) return;
    state.drops.set(reason, (state.drops.get(reason) ?? 0) + n);
  }

  function begin(): void {
    if (state.disposed || state.openSpanAt !== null) return;
    state.openSpanAt = Date.now();
  }

  function end(): void {
    if (state.openSpanAt === null) return;
    state.busyMs += Math.max(0, Date.now() - state.openSpanAt);
    state.openSpanAt = null;
  }

  function measure<T>(fn: () => T): T {
    begin();
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.finally(end) as unknown as T;
      }
      end();
      return result;
    } catch (err) {
      end();
      throw err;
    }
  }

  function dispose(): void {
    if (state.disposed) return;
    end(); // fold any open span into busyMs before closing the books
    state.disposed = true;
    if (workloads.get(name) === state) workloads.delete(name);
  }

  return { ingest, emit, drop, begin, end, measure, dispose };
}

function counterSnapshot(
  map: Map<string, number>,
  intervals: Map<string, IntervalRing>,
  window: SnapshotWindow,
  now: number,
): Record<string, WorkloadStreamStat> {
  const out: Record<string, WorkloadStreamStat> = {};
  for (const [k, v] of map) {
    const ring = intervals.get(k);
    out[k] = {
      ...counterRate(v, window),
      maxIntervalMs: ring ? ringMax(ring, now) : 0,
    };
  }
  return out;
}

function snapshotOf(state: WorkloadState, now: number): WorkloadSnapshot {
  const window = snapshotWindow(state.createdAtMs, now);
  const liveBusyMs =
    state.busyMs + (state.openSpanAt !== null ? Math.max(0, now - state.openSpanAt) : 0);

  let dropTotal = 0;
  const byReason: Record<string, number> = {};
  for (const [reason, n] of state.drops) {
    byReason[reason] = n;
    dropTotal += n;
  }

  return {
    name: state.name,
    window,
    utilization: Math.min(1, liveBusyMs / window.uptimeMs),
    busyMs: liveBusyMs,
    inputs: counterSnapshot(state.inputs, state.inputIntervals, window, now),
    outputs: counterSnapshot(state.outputs, state.outputIntervals, window, now),
    drops: { total: dropTotal, ratePerSec: ratePerSec(dropTotal, window), byReason },
  };
}

/** One workload's current snapshot, or `undefined` if `name` isn't
 *  registered (or was already disposed). */
export function workloadSnapshot(name: string, now = Date.now()): WorkloadSnapshot | undefined {
  const state = workloads.get(name);
  return state ? snapshotOf(state, now) : undefined;
}

/** Every live workload's snapshot, keyed by name — the exact value
 *  `system.perfSnapshot` should splice in under its additive `workloads`
 *  key (see the C-6 log for the handoff needed in `system.ts`/`contracts.ts`,
 *  which this round doesn't touch — out of C's file ownership). */
export function workloadsSnapshot(now = Date.now()): Record<string, WorkloadSnapshot> {
  const out: Record<string, WorkloadSnapshot> = {};
  for (const state of workloads.values()) out[state.name] = snapshotOf(state, now);
  return out;
}
