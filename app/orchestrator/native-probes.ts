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

/** Merge every registered native probe batch — spliced into
 *  `perfSnapshot.workloads`. A throwing probe is skipped, never breaking the
 *  snapshot. */
export function nativeProbes(): Record<string, WorkloadSnapshot> {
  const out: Record<string, WorkloadSnapshot> = {};
  for (const source of sources) {
    try {
      Object.assign(out, source());
    } catch {
      // a native probe must never break the perf snapshot
    }
  }
  return out;
}
