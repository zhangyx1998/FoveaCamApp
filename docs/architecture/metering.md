# Workload metering and the profiler

> Source of truth: `app/orchestrator/metering.ts`,
> `app/lib/orchestrator/stats.ts` (snapshot shapes),
> `app/orchestrator/native-probes.ts`, `app/src/profiler/*`
> (`workload-view.ts`, `graph-view.ts`, `ProfilerWindow.vue`).

## 1. The contract: observe, never gate

Any loop-like unit registers once —
`registerWorkload(name, { inputs, outputs })` — and calls the returned handle
from its hot path: `ingest`/`emit` (count named stream events), `drop`
(reason-bucketed), `begin`/`end`/`measure` (busy spans; `measure` keeps the
span open across a returned promise). **Every method is a safe no-op after
`dispose()`** and `measure` always runs the wrapped function: a metering bug
must never throw into, gate, or change the outcome of the metered path. For
the same reason double-registration replaces-and-warns instead of throwing.

## 2. Snapshot schema

`WorkloadSnapshot` (plain data, `stats.ts`): `{ name, window{startedAt,
snapshotAt, uptimeMs}, utilization, busyMs, inputs/outputs:
Record<string, CounterRate & {maxIntervalMs}>, drops{total, ratePerSec,
byReason} }`.

- **Interval vs cumulative:** the meter's own rates are cumulative since
  registration; the profiler diffs successive snapshots (same `startedAt`,
  advancing `snapshotAt`) for "last tick" numbers, falling back to cumulative
  when not diffable (`workload-view.ts`, pure + unit-tested).
- **Max-interval ring:** per stream, 10 × 1 s bins track the worst
  inter-arrival gap over the trailing 10 s; an in-progress stall reports live
  as `now − lastEvent`. A stream whose worst gap exceeds 2× its nominal
  period is flagged **stalled**.

## 3. Native probes

Native threads (pipe publishers, converters, undistort, KCF) keep their own
ThreadMeter and expose it in the SAME plain-data shape.
`registerNativeProbe(source) → dispose` merges probe batches into
`perfSnapshot.workloads` at snapshot time — the orchestrator probes
**out-of-loop** (never per-frame), and `system.ts` stays core-free because
probes are injected at wiring sites (`orchestrator/index.ts`, sessions).

## 4. Meter naming

Pipe-backed meters are named by their **node id** (`stream-graph.md`), so
graph badges and table rows key identically: `camera/<serial>/convert`,
`camera/<serial>/undistort`, … Legacy `:`-form families still exist for
non-graph meters: `controller:<port>` (one `packets` output per serial write —
config, actuate, stream create/terminate, CMD_FRAME, and the fire-and-forget
stream-update hot path; actuate round-trips are timed as busy),
`recorder:<name>`, `viewer:<fileId>`.

## 5. The profiler

A singleton sandboxed window (`windows.md`), read-only over telemetry —
passive subscriptions so opening it never starts actuation or camera taps
(V12). One 1 Hz `perfSnapshot` call feeds everything:

- **Workload table** — sorted by utilization descending; anything ≥ 0.9 gets
  the red **SATURATED** flag (badge + rail). The busiest workload is almost
  always the fps cap, and the flag makes an unexpected bottleneck obvious —
  e.g. a `registry:<serial>` JS view-tap loop reading 0.99 while the native
  converters sit idle.
- **Graph panel** — the live node graph (`stream-graph.md` §6).
- **Rates/streams/spans** — channel frame rates, controller stream Hz,
  boot/step spans; snapshot export writes the whole `PerfSnapshot` to disk
  for offline baseline comparison.
