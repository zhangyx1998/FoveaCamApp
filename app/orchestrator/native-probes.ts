// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Native instrumentation seam: the free-running C++ threads (SHM pipe producers via
// Pipe.probeAll(), the KCF tracker via tk.probe()) expose native meters in the
// WorkloadSnapshot shape, probed OUT-OF-LOOP. This tiny registry folds them into
// system.perfSnapshot.workloads WITHOUT system.ts touching core (index injects
// Pipe.probeAll, the tracking session injects its tracker's probe, system.ts merges) —
// keeping the snapshot builder native-free and rendering native streams like JS ones.
// spec: docs/spec/orchestrator-runtime.md#native-probes

import type { NodeReport } from "@lib/orchestrator/graph-contract.js";
import type { QueueStat, WorkloadSnapshot } from "@lib/orchestrator/stats.js";

/** A native probe batch — a set of workload snapshots keyed by name, read at
 *  snapshot time. Returns `{}` when its threads are idle (no stale rows). */
export type NativeProbeSource = () => Record<string, WorkloadSnapshot>;

const sources = new Set<NativeProbeSource>();

/** Register a native probe batch; returns a disposer (call on teardown). */
export function registerNativeProbe(source: NativeProbeSource): () => void {
  sources.add(source);
  return () => sources.delete(source);
}

/** Coerce a probe row to the FULL `WorkloadSnapshot` schema. A malformed row
 *  (a flat `uptimeMs`/`dropTotal` shape with no `window`/`drops`) must never
 *  crash `perfSnapshot` — a `.ratePerSec` of undefined blanks the graph and
 *  fails export. Extra fields (e.g. multi-KCF `targets`) pass through
 *  untouched. */
export function normalizeProbeRow(row: WorkloadSnapshot): WorkloadSnapshot {
  const r = row as WorkloadSnapshot &
    Partial<{ uptimeMs: number; dropTotal: number }>;
  const uptimeMs = r.window?.uptimeMs ?? r.uptimeMs ?? 1;
  const total = r.drops?.total ?? r.dropTotal ?? 0;
  // FIFO queue stats: the undistort
  // brick's snapshot carries `queue: {depth, highWater, capacity}`; Leaky
  // bricks omit it. Pass it through ONLY when fully well-formed — a partial /
  // malformed row must degrade to `queue` absent, never blank the graph (same
  // defensive contract as the `drops`/`window` normalization above).
  const queue = normalizeQueue(r.queue);
  return {
    ...r,
    window: r.window ?? { startedAt: 0, snapshotAt: 0, uptimeMs },
    utilization: r.utilization ?? 0,
    busyMs: r.busyMs ?? 0,
    inputs: r.inputs ?? {},
    outputs: r.outputs ?? {},
    drops: r.drops ?? {
      total,
      ratePerSec: uptimeMs > 0 ? total / (uptimeMs / 1000) : 0,
      byReason: {},
    },
    // Overrides any malformed `queue` swept in by `...r` (present → undefined).
    queue,
  };
}

/** Coerce a raw probe `queue` field to `QueueStat`, or `undefined` when absent
 *  or malformed (any of the three fields missing/non-numeric). Never throws. */
function normalizeQueue(q: unknown): QueueStat | undefined {
  if (!q || typeof q !== "object") return undefined;
  const { depth, highWater, capacity } = q as Record<string, unknown>;
  if (
    typeof depth === "number" &&
    typeof highWater === "number" &&
    typeof capacity === "number"
  )
    return { depth, highWater, capacity };
  return undefined;
}

// --- Universal node reports --------------------------------------------------
//
// Same seam, one level up: alongside the per-name workload probes, a source
// can report whole `NodeReport` batches — id + kind + transport + ACTUAL input
// connections + optional stats in the converged `WorkloadSnapshot` schema.
// `buildTopology` merges these AFTER its compat adapters (a real report wins
// by id over an adapter-synthesized node); the native `Topology.report()`
// NAPI will register here, as will JS workers/sessions as they migrate off
// `registerGraphWiring`.

/** A node-report batch — the universal reporting shape, read at snapshot
 *  time. Returns `[]` when nothing is live (no stale rows). */
export type NodeReportSource = () => NodeReport[];

const reportSources = new Set<NodeReportSource>();

/** Register a node-report batch; returns a disposer (call on teardown). */
export function registerNodeReports(source: NodeReportSource): () => void {
  reportSources.add(source);
  return () => reportSources.delete(source);
}

/** Concatenate every registered node-report batch — fed to `buildTopology`'s
 *  `reports` dep. Same isolation contract as `nativeProbes()`: a throwing or
 *  malformed source is skipped, never breaking the snapshot; stats rows are
 *  coerced to the full `WorkloadSnapshot` schema on the way through. */
export function nodeReports(): NodeReport[] {
  const out: NodeReport[] = [];
  for (const source of reportSources) {
    try {
      const batch = source();
      if (!Array.isArray(batch)) continue;
      for (const report of batch) {
        if (!report || typeof report.id !== "string") continue;
        out.push(
          report.stats
            ? { ...report, stats: normalizeProbeRow(report.stats) }
            : report,
        );
      }
    } catch {
      // a reporting node must never break the perf snapshot
    }
  }
  return out;
}

/** Merge every registered native probe batch — spliced into
 *  `perfSnapshot.workloads`. A throwing probe is skipped, never breaking the
 *  snapshot. */
export function nativeProbes(): Record<string, WorkloadSnapshot> {
  const out: Record<string, WorkloadSnapshot> = {};
  for (const source of sources) {
    try {
      for (const [name, row] of Object.entries(source()))
        out[name] = normalizeProbeRow(row);
    } catch {
      // a native probe must never break the perf snapshot
    }
  }
  return out;
}
