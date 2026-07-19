# Stream graph topology — behavior spec

Behavioral contracts for the orchestrator's node-graph reporting and metering.
Source pointers are per section; the code carries only load-bearing invariants inline.

## graphTopology fold {#graph-topology}

Source: `app/orchestrator/graph-topology.ts`

The universal node-reporting fold assembles the live stream-node graph the profiler
renders, served inside `system.perfSnapshot` (the existing 1 Hz poll).

One shape, every node type: nodes self-report as `NodeReport` (contract in
`@lib/orchestrator/graph-contract`) and `buildTopologyFromReports` is a mechanical
fold — nodes = reports (stats folded by id from the workloads map when a report carries
none), edges = flatten(report.inputs). A node missing from the graph means it isn't
reporting, never that derivation guessed wrong.

### Migration adapters

Today only part of the pipeline self-reports, so two adapters synthesize reports from
the legacy surfaces:

- `pipeListToReports` wraps `Pipe.list()` rows — reproduces the camera-root
  synthesis (implicit `camera/<serial>` node + the physical camera→brick input; the
  convert/undistort/fovea bricks all tap the raw camera stream inside their fused
  native pipelines, so a fovea does NOT read the undistort pipe even though its id
  nests under /undistort/). Removed once the native `Topology.report()` NAPI lands.
- `wiringToReports` wraps the `registerGraphWiring` stage-1 shim (sessions register
  fixed compositions on activate, dispose on drain) — edges move into the target
  node's `inputs`, legacy `statsKey` folding preserved. Dies when sessions/workers
  post `NodeReport`s directly.

`buildTopology(deps)` keeps a stable signature/behavior as a thin composition:
adapters → (optional) real reports from `deps.reports` (merged AFTER the adapters — a
real report REPLACES an adapter-synthesized node of the same id) →
`buildTopologyFromReports`. `system.ts` needs no changes.

### Defensive read

A malformed report / probe row degrades to a partial node, never throws — one bad row
must not blank the graph or break snapshot export.

## Workload metering {#metering}

Source: `app/orchestrator/metering.ts`

A common perf-reporting abstraction any loop-like unit in the orchestrator registers once,
so the native tracker/pipe thread probes and the recorder worker all become instances of
the same schema instead of hand-grown counters. Vue-free — built on the `rolling.ts`
lineage (RollingStats / allFrameStats window bookkeeping), never `perf.ts` (Vue-tainted,
renderer-only).

Hard rule (kept at the code): meters observe, never gate. Every `WorkloadHandle` method is
a safe no-op once `dispose()`d (and `measure()` still always invokes the wrapped function)
— a wiring bug or a caller reusing a handle after teardown must never throw into, or change
the outcome of, the metered path.
