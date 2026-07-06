// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Workload metering core (Stage 5, docs/refactor/workload-metering.md).
// A common perf-reporting abstraction any loop-like unit in the orchestrator
// registers once, so `frame-worker`'s busy-drop counting, the registry's
// per-serial preview loop, and the recorder worker all become instances of
// the same schema instead of hand-grown counters. Vue-free — `rolling.ts`
// lineage (`RollingStats`/`allFrameStats`'s T10-style window bookkeeping),
// never `perf.ts` (Vue-tainted, renderer-only).
//
// Hard rule: meters observe, never gate. Every method on a `WorkloadHandle`
// is a safe no-op once `dispose()`d (or, for `measure()`, still always
// invokes the wrapped function) — a bug in wiring or a caller reusing a
// handle after teardown must never throw into, or change the outcome of,
// the metered path.

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
   *  `allWorkloadSnapshots()`). Idempotent. */
  dispose(): void;
}

export interface WorkloadCounterSnapshot {
  count: number;
  ratePerSec: number;
}

export interface WorkloadDropSnapshot {
  total: number;
  ratePerSec: number;
  byReason: Record<string, number>;
}

/** One workload's aggregated document — the shape `system.perfSnapshot`'s
 *  `workloads` key exports per-name (docs/refactor/workload-metering.md §2).
 *  Window bookkeeping matches `FrameTopicStats` exactly (T10-style,
 *  cumulative-since-registration, never assumed): `uptimeMs` divides every
 *  rate, so a freshly-registered workload with one sample doesn't report an
 *  absurd instantaneous rate. */
export interface WorkloadSnapshot {
  name: string;
  window: { startedAt: number; snapshotAt: number; uptimeMs: number };
  /** Busy-time fraction of `window.uptimeMs`, clamped to [0, 1]. Cumulative
   *  since registration, same lineage as the rates below — not a "since last
   *  snapshot" reading (no `resetMax`-style call needed to read it). */
  utilization: number;
  /** Cumulative busy milliseconds (including time in a currently-open span,
   *  so a mid-iteration read isn't stuck at the last `end()`). */
  busyMs: number;
  inputs: Record<string, WorkloadCounterSnapshot>;
  outputs: Record<string, WorkloadCounterSnapshot>;
  drops: WorkloadDropSnapshot;
}

interface WorkloadState {
  name: string;
  createdAtMs: number;
  busyMs: number;
  openSpanAt: number | null;
  inputs: Map<string, number>;
  outputs: Map<string, number>;
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

  const state: WorkloadState = {
    name,
    createdAtMs: Date.now(),
    busyMs: 0,
    openSpanAt: null,
    inputs: new Map(spec.inputs.map((k) => [k, 0])),
    outputs: new Map(spec.outputs.map((k) => [k, 0])),
    drops: new Map(),
    disposed: false,
  };
  workloads.set(name, state);

  function ingest(input: string, n = 1): void {
    if (state.disposed) return;
    state.inputs.set(input, (state.inputs.get(input) ?? 0) + n);
  }

  function emit(output: string, n = 1): void {
    if (state.disposed) return;
    state.outputs.set(output, (state.outputs.get(output) ?? 0) + n);
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

function counterSnapshot(map: Map<string, number>, sec: number): Record<string, WorkloadCounterSnapshot> {
  const out: Record<string, WorkloadCounterSnapshot> = {};
  for (const [k, v] of map) out[k] = { count: v, ratePerSec: v / sec };
  return out;
}

function snapshotOf(state: WorkloadState, now: number): WorkloadSnapshot {
  const uptimeMs = Math.max(1, now - state.createdAtMs);
  const sec = uptimeMs / 1000;
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
    window: { startedAt: state.createdAtMs, snapshotAt: now, uptimeMs },
    utilization: Math.min(1, liveBusyMs / uptimeMs),
    busyMs: liveBusyMs,
    inputs: counterSnapshot(state.inputs, sec),
    outputs: counterSnapshot(state.outputs, sec),
    drops: { total: dropTotal, ratePerSec: dropTotal / sec, byReason },
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
export function allWorkloadSnapshots(now = Date.now()): Record<string, WorkloadSnapshot> {
  const out: Record<string, WorkloadSnapshot> = {};
  for (const state of workloads.values()) out[state.name] = snapshotOf(state, now);
  return out;
}
