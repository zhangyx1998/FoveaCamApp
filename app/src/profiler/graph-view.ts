// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Profiler graph panel — pure view-model layer (Vue/cytoscape-free, unit-tested):
// topology source selection + Stage-1 derivation, cytoscape reduction, idle/busy
// semantics, edge/hover math, membership-key relayout gating.
// spec: docs/spec/profiler-graph.md

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

import { utilizationLevel, type WorkloadRow, type WorkloadCounterRow } from "./workload-view";

// --- Stage-1 derivation ----------------------------------------------------

const FRAME = (
  pixelFormat: string,
  dtype: import("@lib/orchestrator/graph-contract").ContainerDtype,
): StreamType => ({
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
  // legacy families (controller:*, recorder:*, …) until their nodes migrate.
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

    // Known standalone families — path-ified id, kind from the name's root.
    // `controller:<port>` / `recorder:<name>` / `viewer:<file>` → sinks;
    // anything else → a generic metered node. (The legacy `tracking:kcf`
    // mapping died with the tracking-single app — KCF meters are path-like
    // now: camera/<serial>/kcf, /kcf-multi, /undistort/kcf, handled by the
    // "/" branch above via kindOf.)
    const root = row.name.split(":")[0] || "workload";
    const kindMap: Record<string, { kind: string; output: StreamType | null }> = {
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

/** Serial→role abbreviation map ("L"/"C"/"R") published by the session that
 *  leases the camera triple (rides `GraphTopology.roles`). manage-cameras
 *  publishes none → serials stay (they ARE the identity there). */
export type RoleMap = Record<string, string>;

/** The action tail of a camera-rooted id: the LAST meaningful action segment
 *  plus any trailing numeric slot, with the structural breadcrumb dropped
 *  (`undistort/fovea/2` → `fovea/2`, `undistort/kcf` → `kcf`). The graph EDGES
 *  already carry the chain, so labels stay short (no `undistort/…` prefix). */
function actionTail(tail: string): string {
  const segs = tail.split("/");
  let i = segs.length - 1;
  while (i > 0 && /^\d+$/.test(segs[i]!)) i--; // keep trailing numeric slot(s)
  const slot = segs.slice(i + 1).join("/");
  return slot ? `${segs[i]}/${slot}` : segs[i]!;
}

/** Node caption. In an application context a leased camera shows its ROLE
 *  (L/C/R) instead of its serial — `camera/<serial>` → `C`, middleware →
 *  `<role>/<action>` (e.g. `C/undistort`, `C/fovea/2`) with NO upstream
 *  breadcrumb. Unknown serials + non-camera nodes fall back to the 2-segment
 *  tail. Metrics live in the hover card (`nodeDetail`, keyed on the full id);
 *  the saturated red styling stays always-on so the bottleneck screams. */
export function nodeLabel(node: GraphNode, roles?: RoleMap): string {
  const cam = /^camera\/([^/]+)(?:\/(.+))?$/.exec(node.id);
  const role = cam ? roles?.[cam[1]!] : undefined;
  if (cam && role) return cam[2] ? `${role}/${actionTail(cam[2])}` : role;
  return node.id.split("/").slice(-2).join("/");
}

/** The app-wide L/C/R color identity (tokens.css --role-l/-c/-r; cytoscape's
 *  JS stylesheet can't read CSS custom properties, so the values are mirrored
 *  here like KIND_COLORS). Border tint only — fills stay kind-colored. */
const ROLE_COLORS: Record<string, string> = {
  L: "cyan",
  C: "orange",
  R: "greenyellow",
};

/** Border tint for role-labeled camera-chain nodes; undefined when the node
 *  has no known role (falls back to the default border). */
export function roleColor(node: GraphNode, roles?: RoleMap): string | undefined {
  const cam = /^camera\/([^/]+)/.exec(node.id);
  const role = cam ? roles?.[cam[1]!] : undefined;
  return role ? ROLE_COLORS[role] : undefined;
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

// --- Renderer consumer-sink collapse (user 2026-07-10) ----------------------

/** The single collapsed renderer node id (see `collapseConsumerSinks`). */
export const RENDERER_ID = "renderer";
const CONSUMER_SINK_RE = /\/consumers$/;

/** Collapse the anonymous per-pipe SHM consumer sinks (`<pipeId>/consumers`,
 *  kind "view"/transport "sink" — emitted by `graph-topology.ts`) into ONE
 *  shared `renderer` node: every consuming pipe keeps its OWN fan-in edge (rate
 *  + consumer refcount preserved in the edge/hover detail), so the graph loses
 *  N anonymous sinks without losing any flow information. Real orchestrator-side
 *  consumers (workers, recorder, capture, win/ nodes) are NOT sinks matching
 *  this pattern and pass through untouched. Idempotent + reference-stable when
 *  there is nothing to collapse (no re-layout churn). */
export function collapseConsumerSinks(t: GraphTopology): GraphTopology {
  const sinks = new Set(
    t.nodes.filter((n) => n.transport === "sink" && CONSUMER_SINK_RE.test(n.id)).map((n) => n.id),
  );
  if (sinks.size === 0) return t;
  const nodes: GraphNode[] = t.nodes.filter((n) => !sinks.has(n.id));
  nodes.push({ id: RENDERER_ID, kind: "renderer", output: null, transport: "sink" });
  const edges: GraphEdge[] = t.edges.map((e) =>
    sinks.has(e.to) ? { ...e, to: RENDERER_ID } : e,
  );
  return { ...t, nodes, edges };
}

// --- Idle derivation (user 2026-07-10) --------------------------------------

/** IDLE = not running because nothing downstream DEMANDS the output — a
 *  consumer-gated producer parked by design (C-21 gate), an EXPECTED state that
 *  renders desaturated + dimmed with an "idle" caption, NOT the red stalled
 *  accent. Positive no-demand evidence, propagated UPSTREAM over the topology:
 *   - a pipe node whose `pipe.consumers === 0` — zero SHM subscribers (the
 *     production signal: a 0-consumer pipe emits NO consumer edge, so the count
 *     rides the node) — and no live native/worker consumer either;
 *   - an explicit `consumers === 0` on a consumer edge (the aggregate sink);
 *   - a node every one of whose downstream consumers is ITSELF idle (hollow
 *     demand — a parked subscriber is no demand).
 *  Conversely a pipe with `pipe.consumers > 0` is DEMANDED (live SHM readers).
 *  A node with a positive rate is NEVER idle (demonstrably spinning). A
 *  zero-rate node with ANY live downstream is STALLED (kept red), not idle.
 *  Demand that cannot be positively DISPROVEN (an unmetered terminal producer
 *  with no pipe count, a non-pipe edge with no consumer count) defaults to
 *  LIVE — never invent idle, a false "idle" would hide a real stall. */
export interface IdleSet {
  nodes: Set<string>;
  edges: Set<string>;
}

export function deriveIdle(t: GraphTopology): IdleSet {
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  const push = (m: Map<string, GraphEdge[]>, k: string, e: GraphEdge): void => {
    const arr = m.get(k);
    if (arr) arr.push(e);
    else m.set(k, [e]);
  };
  for (const e of t.edges) {
    push(out, e.from, e);
    push(inc, e.to, e);
  }
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const memo = new Map<string, boolean>();
  const onStack = new Set<string>();

  // Mutually recursive over the DAG; function declarations so the forward
  // reference resolves and the cycle guard (PID feedback loops) can't hang.
  function nodeIdle(id: string): boolean {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (onStack.has(id)) return false; // cycle → treat as demanded, never false-idle
    onStack.add(id);
    const node = byId.get(id);
    let idle: boolean;
    const pipe = node?.pipe;
    const stats = node?.stats;
    if ((stats?.ratePerSec ?? 0) > 0 || (stats?.utilization ?? 0) > 0 || stats?.saturated) {
      // Demonstrably spinning (rate) OR burning CPU (util/saturated): a pegged
      // node that emits nothing is a STALL and must never paint as parked —
      // the saturated red stays the loudest thing. Parked C-21 producers have
      // ~0 util, so util > 0 is a safe not-parked gate.
      idle = false;
    } else if (pipe && (pipe.consumers ?? 0) > 0) {
      idle = false; // live SHM subscribers = real demand
    } else {
      const outs = out.get(id) ?? [];
      if (outs.length > 0) {
        idle = outs.every(edgeIdle); // demand only via live downstream edges
      } else if (pipe) {
        idle = true; // a metered pipe with 0 consumers and no consumer edge = parked
      } else {
        // Terminal, no pipe count: a consumer/sink is idle ONLY with positive
        // no-demand evidence (every feeding edge reports zero subscribers); an
        // unmetered producer defaults to live (never invent idle).
        const ins = inc.get(id) ?? [];
        idle = ins.length > 0 && ins.every((e) => e.consumers === 0);
      }
    }
    onStack.delete(id);
    memo.set(id, idle);
    return idle;
  }
  function edgeIdle(e: GraphEdge): boolean {
    // Explicit zero-subscriber pipe → idle; otherwise idle iff the CONSUMER is
    // idle (a `consumers > 0` link into a parked consumer is still hollow).
    return e.consumers === 0 || nodeIdle(e.to);
  }

  const nodes = new Set<string>();
  for (const n of t.nodes) if (nodeIdle(n.id)) nodes.add(n.id);
  const edges = new Set<string>();
  for (const e of t.edges) if (edgeIdle(e)) edges.add(edgeId(e));
  return { nodes, edges };
}

// --- Per-node busy ring (user 2026-07-10, ruling 3) -------------------------

/** Ring badge colors — mirror the Workloads table's tint tiers (tokens
 *  `--accent-bright` / `--warn` + the profiler's coral `#f56`). Cytoscape's JS
 *  stylesheet and data-URI SVGs can't read CSS custom properties, so the values
 *  are mirrored here like `KIND_COLORS` / `ROLE_COLORS` above. */
const RING_TRACK = "#2a2f36"; // unfilled arc (matches the graph chip border)
const RING_OK = "#0af";
const RING_WARN = "#fa0";
const RING_HIGH = "#f56";
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Compact circular busy indicator (ruling 3): a thin arc that fills clockwise
 *  from 12 o'clock to `utilization` of a full turn, color-tiered by the SAME
 *  ok/warn/high thresholds the Workloads table uses (SATURATED ≥ 0.9 → coral).
 *  Returned as an SVG `data:` URI for a cytoscape corner `background-image` —
 *  ADDITIVE over the node's kind/saturated fill, so it never competes with the
 *  semantic colors. Fed live from the folded stats via `data(ring)`, so it
 *  tracks each 1 Hz snapshot in place with no relayout. */
export function busyRing(utilization: number, saturated: boolean): string {
  const u = Math.min(1, Math.max(0, utilization));
  const arc = u * RING_CIRCUMFERENCE;
  const level = utilizationLevel(u);
  const color =
    saturated || level === "high" ? RING_HIGH : level === "warn" ? RING_WARN : RING_OK;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="${RING_RADIUS}" fill="none" stroke="${RING_TRACK}" stroke-width="3"/>` +
    `<circle cx="12" cy="12" r="${RING_RADIUS}" fill="none" stroke="${color}" stroke-width="3" ` +
    `stroke-linecap="round" stroke-dasharray="${arc.toFixed(2)} ${(RING_CIRCUMFERENCE - arc).toFixed(2)}" ` +
    `transform="rotate(-90 12 12)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// --- Parallel-edge lanes (user 2026-07-10) ----------------------------------

/** Lane index + count for SAME-DIRECTION parallel edges (identical `from`→`to`,
 *  distinct port). Bidirectional pairs (A→B / B→A) already separate via their
 *  opposite L/R attachment faces under the perpendicular-stem geometry, so only
 *  same-direction parallels need fanning; the panel maps `lane` to a small
 *  vertical attachment offset on both faces so the perpendicular stems stay
 *  parallel instead of overlapping. Pure — keyed by edgeId. */
function edgeLanes(edges: GraphEdge[]): Map<string, { lane: number; lanes: number }> {
  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const key = `${e.from}\0${e.to}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const out = new Map<string, { lane: number; lanes: number }>();
  for (const g of groups.values())
    g.forEach((e, i) => out.set(edgeId(e), { lane: i, lanes: g.length }));
  return out;
}

/** Reduce a topology to cytoscape element definitions. Pure data — the panel
 *  component diffs these against the live graph by element id. Applies the two
 *  display normalizations (both here so `membershipKey` sees the SAME graph):
 *  SHM consumer-sink collapse, then per-element idle derivation. */
export function toElements(t0: GraphTopology): GraphElement[] {
  const t = collapseConsumerSinks(t0);
  const idle = deriveIdle(t);
  const lanes = edgeLanes(t.edges);
  const els: GraphElement[] = t.nodes.map((n) => ({
    group: "nodes",
    data: {
      id: n.id,
      kind: n.kind,
      label: nodeLabel(n, t.roles),
      detail: nodeDetail(n),
      // In-graph busy indicator (ruling 3): metered nodes carry a live ring
      // data-URI; unmetered nodes omit it (the `node[ring]` selector skips them).
      ...(n.stats?.utilization !== undefined
        ? { ring: busyRing(n.stats.utilization, !!n.stats.saturated) }
        : {}),
      ...(() => {
        const c = roleColor(n, t.roles);
        return c ? { roleColor: c } : {};
      })(),
    },
    // Mutually exclusive BY CONSTRUCTION: deriveIdle vetoes idle on any
    // saturated/util>0 node, so a pegged node always keeps its red accent.
    classes: idle.nodes.has(n.id) ? "idle" : n.stats?.saturated ? "saturated" : "",
  }));
  const known = new Set(t.nodes.map((n) => n.id));
  for (const e of t.edges) {
    // A dangling edge would throw inside cytoscape — skip defensively (the
    // Stage-1 derivation never emits one; a real snapshot glitch must not
    // take the panel down).
    if (!known.has(e.from) || !known.has(e.to)) continue;
    const id = edgeId(e);
    const isIdle = idle.edges.has(id);
    const lane = lanes.get(id) ?? { lane: 0, lanes: 1 };
    els.push({
      group: "edges",
      data: {
        id,
        source: e.from,
        target: e.to,
        // No downstream demand reads "idle" (muted), NOT a red 0 Hz — the
        // stalled accent is reserved for a stall under live demand.
        label: isIdle ? "idle" : edgeLabel(e),
        detail: edgeDetail(e),
        // Same-direction parallel fanning (the perpendicular stems are laid out
        // by the panel from live node positions — `graph-interactions.ts`).
        lane: lane.lane,
        lanes: lane.lanes,
      },
      classes: isIdle ? "idle" : edgeWarns(e) ? "dropping" : "",
    });
  }
  return els;
}

/** Hover DISTANCE (user 2026-07-10): BFS hop distance from the hovered element
 *  over the INCIDENCE graph — a node is adjacent to its incident edges and an
 *  edge to its two endpoint nodes, so from a hovered node its edges are 1 and
 *  their far endpoints 2; from a hovered edge its endpoints are 1. Distance
 *  drives the hover opacity gradient + z-order (nearest on top). Pure — the
 *  panel maps it to per-element opacity/z-index in one batch.
 *
 *  Elements unreachable from the hovered one (a disconnected component) are
 *  ABSENT from the map; the caller floors them. An unknown hovered id (element
 *  churned away mid-hover) → EMPTY map; the panel treats that as "clear hover",
 *  never fades the whole graph to the floor. */
export function hoverDistances(els: GraphElement[], hoveredId: string): Map<string, number> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  const ids = new Set(els.map((e) => e.data.id));
  for (const el of els) {
    if (el.group !== "edges") continue;
    const eid = el.data.id;
    const s = String(el.data.source);
    const t = String(el.data.target);
    link(eid, s);
    link(eid, t);
    link(s, eid);
    link(t, eid);
  }
  const dist = new Map<string, number>();
  if (!ids.has(hoveredId)) return dist;
  dist.set(hoveredId, 0);
  const queue = [hoveredId];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    const d = dist.get(cur)!;
    for (const nb of adj.get(cur) ?? [])
      if (!dist.has(nb)) {
        dist.set(nb, d + 1);
        queue.push(nb);
      }
  }
  return dist;
}

/** Resting opacity of an idle (parked) element — desaturated AND dimmed. Kept
 *  ≤ the hover floor's ceiling so the min() composition below is well-ordered. */
export const IDLE_OPACITY = 0.5;
/** The far/unreachable opacity floor — the graph stays faintly visible on
 *  hover, never fully invisible. */
export const HOVER_OPACITY_FLOOR = 0.16;
const HOVER_OPACITY_STEP = 0.24;

/** Opacity from hover distance: 1.0 at the hovered element, fading linearly and
 *  MONOTONICALLY, clamped to `HOVER_OPACITY_FLOOR` (unreachable = Infinity =
 *  the floor). Distance 0–1 stays clearly readable. */
export function hoverOpacity(dist: number): number {
  if (!Number.isFinite(dist)) return HOVER_OPACITY_FLOOR;
  return Math.max(HOVER_OPACITY_FLOOR, 1 - dist * HOVER_OPACITY_STEP);
}

/** Effective element opacity = MIN(idle-resting, hover-distance) — idle stays
 *  capped at `IDLE_OPACITY` no matter how near the hover, and the hover
 *  gradient can only fade it further. When not hovering the panel skips this
 *  and lets the `.idle` class own the resting opacity. */
export function effectiveOpacity(dist: number, idle: boolean): number {
  return Math.min(idle ? IDLE_OPACITY : 1, hoverOpacity(dist));
}

/** Stable membership key — layout re-runs ONLY when this changes. Normalizes
 *  through `collapseConsumerSinks` so it sees the SAME node/edge set the panel
 *  renders (a stats-only refresh whose consumer count wiggles must not churn
 *  the layout). Nodes are keyed by (id, epoch) per the contract (an epoch bump =
 *  a re-created node = worth a re-layout); stats are deliberately excluded. */
export function membershipKey(t0: GraphTopology): string {
  const t = collapseConsumerSinks(t0);
  const nodes = t.nodes.map((n) => `${n.id}#${n.epoch ?? 0}`).sort();
  const edges = t.edges.map(edgeId).sort();
  return `${nodes.join("|")}//${edges.join("|")}`;
}
