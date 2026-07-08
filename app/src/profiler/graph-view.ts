// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Profiler graph panel — pure view-model layer (A-33, real-2 objective 1).
// Vue-free and cytoscape-free by design (unit-tested in vitest like
// `workload-view.ts`): two pure transforms —
//
//  1. `deriveTopology(...)` — STAGE 1 data source: reconstructs a
//     `GraphTopology` (C-24's contract, `@lib/orchestrator/graph-contract`)
//     from what the profiler already polls today: the interval-diffed
//     `WorkloadRow`s + the pipes session's advertised `PipeAdvert` record +
//     static wiring knowledge (camera→convert→pipe, camera→undistort→pipe).
//     When C-24's real `graphTopology()` lands orchestrator-side, the panel
//     swaps this derivation for the served snapshot — SAME type, zero panel
//     changes (the whole point of building against the contract).
//
//  2. `toElements(...)` / `membershipKey(...)` — reduce a `GraphTopology` to
//     cytoscape element definitions + a stable membership key, so the panel
//     re-runs layout ONLY when the (id, epoch) node set / edge set actually
//     changes — stats-only refreshes at 1 Hz must never move nodes.

import type {
  GraphEdge,
  GraphNode,
  GraphTopology,
  NodeStats,
  StreamType,
} from "@lib/orchestrator/graph-contract";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeAdvert } from "@lib/orchestrator/pipe-contract";
import type { Dtype } from "../../../docs/schema/pixel-formats.js";
import { utilizationLevel, type WorkloadRow, type WorkloadCounterRow } from "./workload-view";

// --- Stage-1 derivation ----------------------------------------------------

const FRAME = (pixelFormat: string, dtype: Dtype): StreamType => ({
  kind: "frame",
  pixelFormat,
  dtype,
});

/** Path-like id sanitizer for LEGACY `:`-family names that embed separators
 *  (serial ports, file paths): `controller:/dev/tty.usb` → `controller/dev/tty.usb`. */
const pathify = (name: string): string =>
  name.replace(/:/g, "/").replace(/\/+/g, "/").replace(/^\//, "");

/** Brick kind from a path-like node id (C-24 scheme): the last non-numeric
 *  segment — `camera/123/convert` → "convert",
 *  `camera/123/undistort/fovea/2` → "fovea". */
function kindOf(id: string): string {
  const segments = id.split("/");
  for (let i = segments.length - 1; i >= 0; i--)
    if (!/^\d+$/.test(segments[i])) return segments[i];
  return segments[0] ?? "node";
}

function badge(row: WorkloadRow): NodeStats {
  const sum = (rows: WorkloadCounterRow[]): number =>
    rows.reduce((a, r) => a + r.ratePerSec, 0);
  const maxInterval = (rows: WorkloadCounterRow[]): number =>
    rows.reduce((a, r) => Math.max(a, r.maxIntervalMs), 0);
  const out = row.outputs.length > 0 ? row.outputs : row.inputs;
  return {
    utilization: row.utilization,
    ratePerSec: sum(out),
    maxIntervalMs: maxInterval(out),
    dropsPerSec: row.drops.ratePerSec,
    dropsTotal: row.drops.total,
    saturated: utilizationLevel(row.utilization) === "high",
  };
}

/**
 * STAGE-2 source selection (A-36): prefer the orchestrator-SERVED topology —
 * C-24's `graphTopology()` riding `PerfSnapshot.graph` (exact byte rates,
 * consumer sinks, session wirings) — and fall back to the Stage-1 derivation
 * below when absent (older orchestrator / graph builder not injected). The
 * fallback thunk is only evaluated on the fallback path.
 */
export function selectTopology(
  served: GraphTopology | undefined,
  fallback: () => GraphTopology,
): GraphTopology {
  return served ?? fallback();
}

/**
 * STAGE 1 (now the FALLBACK + the mock story): derive the graph from today's
 * observable surfaces. Every workload row lands on the graph (matched rows
 * attach stats to a structural node; unmatched rows become standalone nodes
 * keyed by their path-ified name — a meter must never be invisible just
 * because its name pattern is new). `seq`/`at` are supplied by the poller
 * (monotonic tick counter + wall time).
 */
export function deriveTopology(
  workloads: WorkloadRow[],
  pipes: Record<string, PipeAdvert>,
  seq: number,
  at: number,
): GraphTopology {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const ensure = (node: GraphNode): GraphNode => {
    const existing = nodes.get(node.id);
    if (existing) return existing;
    nodes.set(node.id, node);
    return node;
  };
  const cameraNode = (serial: string): GraphNode =>
    ensure({
      id: nodeId.camera(serial),
      kind: "camera",
      // The sensor-native format is not observable from the advert (the spec
      // types the CONVERTED output) — Stage 2's topology carries it natively.
      output: FRAME("sensor-native", "U8"),
      transport: "native",
    });

  // Structural pass: advertised pipes → bricks. Pipe ids ARE path-like node
  // ids now (C-24 step 1, built via `nodeId`): `camera/<serial>/convert`,
  // `camera/<serial>/undistort`, `camera/<serial>/undistort/fovea/<slot>`.
  // Every `camera/<serial>/...` pipe gets its camera source node + the
  // PHYSICAL camera→brick edge (per the nodeId.fovea note: a fovea id nests
  // under /undistort/ but its physical input is the raw camera stream).
  for (const [pipeId, advert] of Object.entries(pipes)) {
    const spec = advert.spec;
    const stream = FRAME(spec.pixelFormat, spec.dtype);
    const brick = ensure({
      id: pipeId,
      kind: kindOf(pipeId),
      output: stream,
      transport: "pipe",
      epoch: advert.epoch,
    });
    const cam = /^camera\/([^/]+)\/./.exec(pipeId);
    if (cam) {
      const source = cameraNode(cam[1]);
      edges.push({ from: source.id, to: brick.id, port: "in", type: source.output! });
    }
  }

  // Stats pass: fold every workload row onto the graph. C-24 step 1: meter
  // names CONTAINING "/" are path-like node ids (B's pipe-backed meters use
  // the pipe id verbatim) — attach directly, or surface a standalone node when
  // no advert built one (e.g. a parked pipe's meter). Names with ":" are
  // legacy families (tracking:kcf, controller:*, …) until their nodes migrate.
  for (const row of workloads) {
    const stats = badge(row);

    if (row.name.includes("/") && !row.name.includes(":")) {
      const node = ensure({
        id: row.name,
        kind: kindOf(row.name),
        output: null,
        transport: "native",
      });
      node.stats = stats;
      const cam = /^camera\/([^/]+)\/./.exec(row.name);
      if (cam && !edges.some((e) => e.to === node.id)) {
        const source = cameraNode(cam[1]);
        edges.push({ from: source.id, to: node.id, port: "in", type: source.output! });
      }
      continue;
    }

    // Legacy JS view-tap loop (dies with C's step-3) — parent it to its camera.
    const registry = /^registry:(.+)$/.exec(row.name);
    if (registry) {
      const cam = cameraNode(registry[1]);
      const node = ensure({
        id: `camera/${registry[1]}/view-loop`,
        kind: "view",
        output: null,
        transport: "sink",
      });
      node.stats = stats;
      edges.push({ from: cam.id, to: node.id, port: "in", type: cam.output! });
      continue;
    }

    // Known standalone families — path-ified id, kind from the name's root.
    // `tracking:kcf` → track output; `controller:<port>` / `recorder:<name>` /
    // `viewer:<file>` → sinks; anything else → a generic metered node.
    const root = row.name.split(":")[0] || "workload";
    const kindMap: Record<string, { kind: string; output: StreamType | null }> = {
      tracking: { kind: "kcf", output: { kind: "track" } },
      controller: { kind: "controller", output: null },
      recorder: { kind: "record", output: null },
      viewer: { kind: "view", output: null },
    };
    const meta = kindMap[root] ?? { kind: root, output: null };
    const node = ensure({
      id: pathify(row.name),
      kind: meta.kind,
      output: meta.output,
      transport: meta.output ? "native" : "sink",
    });
    node.stats = stats;
  }

  return { seq, at, nodes: [...nodes.values()], edges };
}

// --- Cytoscape reduction ----------------------------------------------------

export type GraphElement = {
  group: "nodes" | "edges";
  data: Record<string, unknown> & { id: string };
  classes?: string;
};

const fmtRate = (v: number): string =>
  v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);

/** Node caption: name + badge lines (util% · rate, drops when nonzero) — the
 *  same numbers the workload table shows, reduced to label form. */
export function nodeLabel(node: GraphNode): string {
  const name = node.id.split("/").slice(-2).join("/");
  const s = node.stats;
  if (!s) return name;
  const lines = [name];
  const parts: string[] = [];
  if (s.utilization !== undefined) parts.push(`${(s.utilization * 100).toFixed(0)}%`);
  if (s.ratePerSec !== undefined) parts.push(`${fmtRate(s.ratePerSec)}/s`);
  if (s.maxIntervalMs !== undefined && s.maxIntervalMs > 0)
    parts.push(`≤${s.maxIntervalMs.toFixed(0)}ms`);
  if (parts.length > 0) lines.push(parts.join(" · "));
  if (s.dropsTotal) lines.push(`drops ${s.dropsTotal}`);
  return lines.join("\n");
}

function edgeId(e: GraphEdge): string {
  return `edge:${e.from}->${e.to}#${e.port}`;
}

function edgeLabel(e: GraphEdge): string {
  const parts: string[] = [];
  if (e.ratePerSec !== undefined) parts.push(`${fmtRate(e.ratePerSec)} fps`);
  if (e.bytesPerSec !== undefined) parts.push(`${(e.bytesPerSec / 1e6).toFixed(1)} MB/s`);
  if (e.consumers !== undefined) parts.push(`×${e.consumers}`);
  return parts.join(" ");
}

/** Reduce a topology to cytoscape element definitions. Pure data — the panel
 *  component diffs these against the live graph by element id. */
export function toElements(t: GraphTopology): GraphElement[] {
  const els: GraphElement[] = t.nodes.map((n) => ({
    group: "nodes",
    data: { id: n.id, kind: n.kind, label: nodeLabel(n) },
    classes: n.stats?.saturated ? "saturated" : "",
  }));
  const known = new Set(t.nodes.map((n) => n.id));
  for (const e of t.edges) {
    // A dangling edge would throw inside cytoscape — skip defensively (the
    // Stage-1 derivation never emits one; a real snapshot glitch must not
    // take the panel down).
    if (!known.has(e.from) || !known.has(e.to)) continue;
    els.push({
      group: "edges",
      data: { id: edgeId(e), source: e.from, target: e.to, label: edgeLabel(e) },
    });
  }
  return els;
}

/** Stable membership key — layout re-runs ONLY when this changes. Nodes are
 *  keyed by (id, epoch) per the contract (an epoch bump = a re-created node =
 *  worth a re-layout); stats are deliberately excluded. */
export function membershipKey(t: GraphTopology): string {
  const nodes = t.nodes.map((n) => `${n.id}#${n.epoch ?? 0}`).sort();
  const edges = t.edges.map(edgeId).sort();
  return `${nodes.join("|")}//${edges.join("|")}`;
}
