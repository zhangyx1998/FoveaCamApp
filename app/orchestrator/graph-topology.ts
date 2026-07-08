// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// graphTopology() (C-24 step 2) — assembles the live stream node graph the
// profiler renders (A-33) and the composition UI will browse. Served inside
// `system.perfSnapshot` (ruled Q2: A's existing 1 Hz poll).
//
// Sources:
//  - `Pipe.list()` (C-24 item 2): every advertised SHM pipe → a node, with
//    epoch, consumer refcount, and the exact `bytesTotal` accumulator (item 3)
//    diffed across snapshots for per-edge MB/s.
//  - the perfSnapshot `workloads` map: per-node stats folded BY NODE ID (B's
//    meters are named by pipeId since B-24; legacy-named meters fold via a
//    registered node's `statsKey`).
//  - `registerGraphWiring`: the STAGE-1 SHIM — sessions register their fixed
//    composition (kernel nodes, kcf/detector streams, worker-input sinks) on
//    activate and dispose on drain. Replaced organically by the compose
//    protocol (step 3); the served contract never changes.
//
// Edges are PHYSICAL data paths: B's convert/undistort/fovea bricks all tap the
// raw camera stream inside their fused native pipelines (a fovea does NOT read
// the undistort pipe — that pipe may be gate-parked while foveas run), so every
// camera-rooted brick gets its edge from `camera/<serial>` even though fovea
// IDS nest under /undistort/ (the id names WHAT the output is; edges name how
// it flows).

import type {
  GraphEdge,
  GraphNode,
  GraphTopology,
  NodeStats,
  StreamType,
} from "@lib/orchestrator/graph-contract.js";
import { nodeId } from "@lib/orchestrator/graph-contract.js";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats.js";

/** The `Pipe.list()` row shape this builder consumes (structural — tests drive
 *  it with fakes; production injects the native enumerator). */
export type PipeListRow = {
  id: string;
  spec: { pixelFormat: string; dtype: string };
  epoch: number;
  consumers: number;
  closed: boolean;
  bytesTotal: number;
};

export interface TopologyDeps {
  listPipes(): PipeListRow[];
  workloads(): Record<string, WorkloadSnapshot>;
  now?(): number;
}

/** A registered node may name a LEGACY meter key its stats fold from (e.g.
 *  "tracking:kcf") — node ids and meter names converge (B-24), so new meters
 *  need no statsKey. */
export type WiredNode = GraphNode & { statsKey?: string };
export interface GraphWiring {
  nodes: WiredNode[];
  edges: GraphEdge[];
}

// Same threshold as the profiler's SATURATED styling (utilizationLevel "high").
const SATURATED_UTILIZATION = 0.9;

const wirings = new Set<GraphWiring>();

/** STAGE-1 SHIM: a session registers its fixed composition on activate; the
 *  disposer (drain) removes it. Step 3's compose protocol supersedes this. */
export function registerGraphWiring(wiring: GraphWiring): () => void {
  wirings.add(wiring);
  return () => wirings.delete(wiring);
}

/** Reduce one workload snapshot to the node badge. */
function statsFrom(w: WorkloadSnapshot | undefined): NodeStats | undefined {
  if (!w) return undefined;
  let ratePerSec = 0;
  let maxIntervalMs = 0;
  for (const s of Object.values(w.outputs)) {
    ratePerSec = Math.max(ratePerSec, s.ratePerSec);
    maxIntervalMs = Math.max(maxIntervalMs, s.maxIntervalMs ?? 0);
  }
  return {
    utilization: w.utilization,
    ratePerSec,
    maxIntervalMs,
    dropsPerSec: w.drops.ratePerSec,
    dropsTotal: w.drops.total,
    saturated: w.utilization >= SATURATED_UTILIZATION,
  };
}

/** Brick kind from a camera-rooted path (last segment; a `fovea/<slot>` tail
 *  keys on the second-to-last; `@<format>` modifiers stripped). */
export function kindOfPipeId(id: string): string {
  const segs = id.split("/");
  const last = (segs[segs.length - 1] ?? "").split("@")[0]!;
  if (segs.length >= 2 && segs[segs.length - 2] === "fovea") return "fovea";
  return /^\d+$/.test(last) ? (segs[segs.length - 2] ?? last) : last;
}

// bytesTotal deltas → bytesPerSec, per (id, epoch); an epoch bump resets.
const bytesPrev = new Map<string, { epoch: number; bytes: number; at: number }>();
let seq = 0;

export function buildTopology(deps: TopologyDeps): GraphTopology {
  const at = deps.now?.() ?? Date.now();
  const workloads = deps.workloads();
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const pipe of deps.listPipes()) {
    const segs = pipe.id.split("/");
    // `spec.dtype` is the canonical schema value at runtime; the list row types
    // it as plain string (structural seam) — trusted narrowing.
    const output = {
      kind: "frame",
      pixelFormat: pipe.spec.pixelFormat,
      dtype: pipe.spec.dtype,
    } as StreamType;
    nodes.set(pipe.id, {
      id: pipe.id,
      kind: kindOfPipeId(pipe.id),
      output,
      transport: "pipe",
      epoch: pipe.epoch,
      stats: statsFrom(workloads[pipe.id]),
    });

    // Implicit raw-source root + the PHYSICAL producer edge (see header).
    if (segs[0] === "camera" && segs[1]) {
      const camId = nodeId.camera(segs[1]);
      if (!nodes.has(camId))
        nodes.set(camId, {
          id: camId,
          kind: "camera",
          output: { kind: "frame", pixelFormat: "sensor", dtype: "U8" },
          transport: "native",
          stats: statsFrom(workloads[camId]),
        });
      edges.push({
        from: camId,
        to: pipe.id,
        port: "in",
        type: nodes.get(camId)!.output!,
        ratePerSec: inputRate(workloads[pipe.id]),
      });
    }

    // Aggregate consumer sink (renderer views/one-shot readers connect
    // anonymously via the broker — identity arrives with the compose protocol).
    if (pipe.consumers > 0) {
      const sinkId = `${pipe.id}/consumers`;
      nodes.set(sinkId, {
        id: sinkId,
        kind: "view",
        output: null,
        transport: "sink",
      });
      edges.push({
        from: pipe.id,
        to: sinkId,
        port: "in",
        type: output,
        consumers: pipe.consumers,
        ratePerSec: statsFrom(workloads[pipe.id])?.ratePerSec,
        bytesPerSec: bytesRate(pipe, at),
      });
    } else {
      bytesRate(pipe, at); // keep the delta window warm across idle spans
    }
  }

  // Stage-1 session wiring (kernels, kcf/detect, worker-input sinks).
  for (const wiring of wirings) {
    for (const n of wiring.nodes) {
      if (nodes.has(n.id)) continue; // pipe-derived identity wins
      const { statsKey, ...node } = n;
      nodes.set(n.id, {
        ...node,
        stats: node.stats ?? statsFrom(workloads[statsKey ?? n.id]),
      });
    }
    edges.push(...wiring.edges);
  }

  return { seq: ++seq, at, nodes: [...nodes.values()], edges };
}

function inputRate(w: WorkloadSnapshot | undefined): number | undefined {
  if (!w) return undefined;
  let rate = 0;
  for (const s of Object.values(w.inputs)) rate = Math.max(rate, s.ratePerSec);
  return rate;
}

function bytesRate(pipe: PipeListRow, at: number): number | undefined {
  const prev = bytesPrev.get(pipe.id);
  bytesPrev.set(pipe.id, { epoch: pipe.epoch, bytes: pipe.bytesTotal, at });
  if (!prev || prev.epoch !== pipe.epoch || at <= prev.at) return undefined;
  const dBytes = pipe.bytesTotal - prev.bytes;
  if (dBytes < 0) return undefined;
  return (dBytes * 1000) / (at - prev.at);
}

/** Test hook: reset the module-level delta/seq state between cases. */
export function resetTopologyStateForTest(): void {
  bytesPrev.clear();
  wirings.clear();
  seq = 0;
}
