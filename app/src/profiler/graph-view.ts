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
  EdgeFlow,
  GraphEdge,
  GraphNode,
  GraphTopology,
  NodeStats,
  StreamType,
} from "@lib/orchestrator/graph-contract";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { humanBytesPerSec, humanHz } from "@lib/orchestrator/stats";
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

/** Node caption — the short name ONLY (2 tail segments). Metrics moved to
 *  the hover card (`nodeDetail`); the saturated red styling stays always-on
 *  so the bottleneck still screams without hovering. */
export function nodeLabel(node: GraphNode): string {
  return node.id.split("/").slice(-2).join("/");
}

/** Structured hover card (title + label/value rows) — rendered as a small
 *  table by the panel instead of a pre-line text blob. */
export interface HoverDetail {
  title: string;
  rows: [label: string, value: string][];
}

/** Node hover card: full id (the label truncates to 2 segments) + the
 *  workload numbers that used to crowd the always-on label. */
export function nodeDetail(node: GraphNode): HoverDetail {
  const rows: HoverDetail["rows"] = [["kind", node.kind]];
  const s = node.stats;
  if (s) {
    if (s.utilization !== undefined)
      rows.push([
        "utilization",
        `${(s.utilization * 100).toFixed(0)}%${s.saturated ? " — SATURATED" : ""}`,
      ]);
    if (s.ratePerSec !== undefined) rows.push(["rate", humanHz(s.ratePerSec)]);
    if (s.maxIntervalMs !== undefined && s.maxIntervalMs > 0)
      rows.push(["worst gap", `${s.maxIntervalMs.toFixed(0)} ms`]);
    if (s.dropsTotal)
      rows.push(["drops", `${fmtRate(s.dropsPerSec ?? 0)}/s · ${s.dropsTotal} total`]);
  }
  return { title: node.id, rows };
}

function edgeId(e: GraphEdge): string {
  return `edge:${e.from}->${e.to}#${e.port}`;
}

/** Directional flow fields, preferring the new tx/rx shape; the deprecated
 *  single-direction `ratePerSec`/`bytesPerSec` mirrors map to a tx-only view
 *  (older orchestrator snapshots). */
function txOf(e: GraphEdge): EdgeFlow | undefined {
  if (e.tx) return e.tx;
  if (e.ratePerSec !== undefined || e.bytesPerSec !== undefined)
    return { hz: e.ratePerSec, bytesPerSec: e.bytesPerSec };
  return undefined;
}

/** Drop marker shows ONLY on lossy (latest-wins) links actually dropping —
 *  a FIFO link never shows one, an idle lossy link stays quiet. */
export function isDropping(e: GraphEdge): boolean {
  return !!e.lossy && (e.dropPerSec ?? 0) > 0;
}

/** Backpressure marker: a FIFO (lossless) edge whose consumer queue reached its
 *  capacity over the window — the FIFO actually blocked its producer
 *  (controller-node-and-fifo-edges §2). */
export function isBackpressured(e: GraphEdge): boolean {
  return !!e.queue && e.queue.highWater >= e.queue.capacity;
}

/** The always-on edge WARNING styling (`edge.dropping` class): lossy links
 *  actually dropping OR FIFO links actually backpressured. */
export function edgeWarns(e: GraphEdge): boolean {
  return isDropping(e) || isBackpressured(e);
}

/** Always-on edge caption — the EFFECTIVE rate only: min(tx, rx) when both
 *  directions are metered (the slower side is what downstream actually
 *  receives), the single metered direction otherwise. Everything else
 *  (bytes/s, worst gap, drops, consumers) lives in the hover card; the
 *  warning-red `edge.dropping` styling stays always-on. */
export function edgeLabel(e: GraphEdge): string {
  const tx = txOf(e)?.hz;
  const rx = e.rx?.hz;
  const rate = tx !== undefined && rx !== undefined ? Math.min(tx, rx) : (rx ?? tx);
  return rate !== undefined ? humanHz(rate) : "";
}

function flowValue(f: EdgeFlow): string | null {
  const parts: string[] = [];
  if (f.hz !== undefined) parts.push(humanHz(f.hz));
  if (f.bytesPerSec !== undefined) parts.push(humanBytesPerSec(f.bytesPerSec));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Edge hover card: full directional breakdown (rates + byte rates + worst
 *  inter-arrival gaps), drop rate, consumer refcount. */
export function edgeDetail(e: GraphEdge): HoverDetail {
  const rows: HoverDetail["rows"] = [["port", e.port]];
  const tx = txOf(e);
  const rx = e.rx;
  const txValue = tx && flowValue(tx);
  if (txValue) rows.push(["tx", txValue]);
  const rxValue = rx && flowValue(rx);
  if (rxValue) rows.push(["rx", rxValue]);
  const gaps: string[] = [];
  if (tx?.maxIntervalMs) gaps.push(`↑ ${tx.maxIntervalMs.toFixed(0)} ms`);
  if (rx?.maxIntervalMs) gaps.push(`↓ ${rx.maxIntervalMs.toFixed(0)} ms`);
  if (gaps.length > 0) rows.push(["worst gap", gaps.join(" · ")]);
  // FIFO (lossless) edges show the high-water mark IN PLACE OF the drops row
  // (§2); drops and queue are mutually exclusive in practice (drops absent on
  // non-lossy edges).
  if (e.queue) {
    const q = e.queue;
    const depth = q.depth !== undefined ? ` · now ${q.depth}` : "";
    rows.push(["queue", `hwm ${q.highWater} / cap ${q.capacity} (10s)${depth}`]);
  } else if (isDropping(e)) {
    rows.push(["drops", `${fmtRate(e.dropPerSec!)}/s (lossy latest-wins)`]);
  }
  if (e.consumers !== undefined) rows.push(["consumers", `×${e.consumers}`]);
  return { title: `${e.from} → ${e.to}`, rows };
}

/** Reduce a topology to cytoscape element definitions. Pure data — the panel
 *  component diffs these against the live graph by element id. */
export function toElements(t: GraphTopology): GraphElement[] {
  const els: GraphElement[] = t.nodes.map((n) => ({
    group: "nodes",
    data: { id: n.id, kind: n.kind, label: nodeLabel(n), detail: nodeDetail(n) },
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
      data: {
        id: edgeId(e),
        source: e.from,
        target: e.to,
        label: edgeLabel(e),
        detail: edgeDetail(e),
      },
      classes: edgeWarns(e) ? "dropping" : "",
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
