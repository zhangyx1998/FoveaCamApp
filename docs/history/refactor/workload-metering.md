# Plan: Workload Metering + Profiler Reorganization (Stage 5, item 3)

> **Status:** Core landed — C-6 planner-accepted 2026-07-06 (meter
> abstraction + registry/frame-worker/recorder wiring + 14 fake-timer
> tests; snapshot schema per §2 with `byReason` drop breakdown).
> Export splice + call-site naming landed (A-8). **Profiler UI half
> landed & accepted 2026-07-06 (C-7):** uniform per-workload sections
> (utilization bar with printed %, in/out rates, drops byReason) fed by
> a pure, unit-tested snapshot-diff transform (`workload-view.ts`,
> interval-based with cumulative fallback, snapshot-clock only);
> dedicated sections (spans, loop lag, serial probes, channel rates)
> retained. Item 3 is functionally COMPLETE pending the user's live
> profiler check (manual checklist in C-7's log/git history).
> **Owner:** Yuxuan (direction) / planner (spec) / coder threads (impl).
> **Related:** [`orchestrator.md`](./orchestrator.md) §7.3 (the existing
> perf substrate this generalizes: RollingStats, loop-lag probes, T10
> window bookkeeping, `system.perfSnapshot`),
> [`multi-window.md`](./multi-window.md) (profiler window lives in the
> new window framework), [`recorder-container.md`](./recorder-container.md)
> (the recorder is a flagship metered workload).

## 1. Requirement (user, 2026-07-06)

The profiler should be organized better and provide more insight into
the threads/loops running behind the orchestrator. Do it by abstracting
a **common perf-reporting infrastructure** shared by all workload
kinds — e.g. **ingest rate per input stream, % busy time per iteration,
output rate to downstream consumers**.

## 2. The abstraction (planner sketch)

One `Workload` meter any loop-like unit registers once:

```
registerWorkload(name, {
  inputs:  ["<input name>", ...],   // ingest counters (per named input)
  outputs: ["<output name>", ...],  // emit counters (per named consumer)
})
→ { ingest(input), begin()/end() or measure(fn), emit(output, n?),
    drop(reason?), dispose() }
```

- **Utilization** = busy-time fraction per wall-clock window (the number
  that would have flagged PB1 and PB3 immediately).
- **Rates** derived via T10-style window bookkeeping (startedAt/uptime),
  never assumed.
- **Drops/coalescing** are first-class (latest-wins gates, bounded
  queues) — `frame-worker.ts`'s busy-drop and the Channel per-topic
  counters become instances of the same schema.
- Export: aggregated into `system.perfSnapshot` under a `workloads` key
  (additive); live telemetry at the existing 1 Hz throttles.
- Vue-free (orchestrator side) — `rolling.ts` lineage, not `perf.ts`.

## 3. Candidate workloads (first citizens)

| Workload | Inputs | Outputs | Notes |
|---|---|---|---|
| Registry preview loop (per serial) | camera frames | shm slots, view taps | convertMs already measured; busy% new |
| `frame-worker` gates (per session/view) | tap copies | published topics | busy-drop already counted — adopt schema |
| Actuation loops | target updates | serial actuates | actuateMs exists; utilization new |
| Recorder worker | frame handoffs | container writes | flagship for recorder-container.md; drops critical |
| Shm writers (per topic ring) | slot writes | descriptors | generation churn visible |
| Scheduler (`RoundRobinFrameScheduler`) | stream targets | frame requests | in-flight/requeue counts |
| Native side (serial RX, AsyncTask pool) | — | — | same schema, fed from `Device.stats`-style counters polled from JS (B-owned) |

## 4. Profiler reorganization (UI half)

One uniform section per registered workload (name, utilization bar,
ingest/output rate table, drop counters) replacing today's hand-grown
panels; existing specialized views (span timeline, loop lag, serial
probes) remain as dedicated sections. Lives in the profiler window
under the multi-window framework (still sandboxed, stats-only).

## 5. Sequencing

Mostly independent of multi-window — the meter + snapshot half can run
in parallel (A for app-side, B for native counters); the UI half lands
with or after the window framework. The recorder (item 4) should be
built *already metered* — land the meter first or together.
