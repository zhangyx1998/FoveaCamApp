// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 real-1c/1d instrumentation seam (A-24 Stage 3). The free-running C++
// threads — C's SHM pipe producers (`Pipe.probeAll()`) and B's 1d KCF tracker
// (`tk.probe()`) — expose native meters in the `WorkloadSnapshot` shape, probed
// OUT-OF-LOOP. This tiny registry folds those probes into
// `system.perfSnapshot.workloads` alongside the JS meters, WITHOUT `system.ts`
// touching `core`: the orchestrator index injects `Pipe.probeAll`, the tracking
// session injects its tracker's probe, and `system.ts` just merges them. Keeps
// the snapshot builder native-free (so its vitest keeps running) and lets the
// profiler render a native producer/tracker stream identically to a JS one.

import type { WorkloadSnapshot } from "@lib/orchestrator/stats.js";

/** A native probe batch — a set of workload snapshots keyed by name, read at
 *  snapshot time. Returns `{}` when its threads are idle (no stale rows). */
export type NativeProbeSource = () => Record<string, WorkloadSnapshot>;

const sources = new Set<NativeProbeSource>();

/** Register a native probe batch; returns a disposer (call on teardown). */
export function registerNativeProbe(source: NativeProbeSource): () => void {
  sources.add(source);
  return () => sources.delete(source);
}

/** Coerce a probe row to the FULL `WorkloadSnapshot` schema. The converter/
 *  tracker serializers historically emitted a flat shape (`uptimeMs` +
 *  `dropTotal`, no `window`/`drops`), and one malformed row crashed the whole
 *  `perfSnapshot` (rig 2026-07-08: `.ratePerSec` of undefined → empty graph +
 *  failed export in every app). The native side is schema-converged now; this
 *  keeps any future probe from ever taking the snapshot down again. Extra
 *  fields (e.g. multi-KCF `targets`) pass through untouched. */
export function normalizeProbeRow(row: WorkloadSnapshot): WorkloadSnapshot {
  const r = row as WorkloadSnapshot &
    Partial<{ uptimeMs: number; dropTotal: number }>;
  const uptimeMs = r.window?.uptimeMs ?? r.uptimeMs ?? 1;
  const total = r.drops?.total ?? r.dropTotal ?? 0;
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
  };
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
