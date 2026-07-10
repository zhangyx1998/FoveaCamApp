// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// graphTopology() v2 — the UNIVERSAL node-reporting fold (unified-time-and-
// topology §6). Assembles the live stream node graph the profiler renders,
// served inside `system.perfSnapshot` (ruled Q2: A's existing 1 Hz poll).
//
// ONE shape, every node type: nodes self-report as `NodeReport` (contract in
// `@lib/orchestrator/graph-contract`) and `buildTopologyFromReports` is a
// mechanical fold — nodes = reports (stats folded BY ID from the workloads
// map when a report carries none), edges = flatten(report.inputs). A node
// missing from the graph means it isn't reporting, never that derivation
// guessed wrong.
//
// MIGRATION STORY (proposal §6/§7): today only part of the pipeline
// self-reports, so two ADAPTERS synthesize reports from the legacy surfaces:
//
//  - `pipeListToReports` wraps `Pipe.list()` rows — reproduces the C-24
//    camera-root synthesis (implicit `camera/<serial>` node + the PHYSICAL
//    camera→brick input; B's convert/undistort/fovea bricks all tap the raw
//    camera stream inside their fused native pipelines, so a fovea does NOT
//    read the undistort pipe even though its id nests under /undistort/).
//    DIES when the native `Topology.report()` NAPI lands (P3) and every brick
//    reports its actual inputs.
//  - `wiringToReports` wraps the `registerGraphWiring` stage-1 shim (sessions
//    register fixed compositions on activate, dispose on drain) — edges move
//    into the TARGET node's `inputs`, legacy `statsKey` folding preserved.
//    DIES when sessions/workers post `NodeReport`s directly (the vision-worker
//    meterName machinery generalizes to the same shape).
//
// `buildTopology(deps)` keeps its exact pre-v2 signature/behavior as a thin
// composition: adapters → (optional) real reports from `deps.reports` (merged
// AFTER the adapters — a real report REPLACES an adapter-synthesized node of
// the same id) → `buildTopologyFromReports`. `system.ts` needs no changes.
//
// Defensive-read guarantee (rig 2026-07-08 regression class): a malformed
// report / probe row degrades to a partial node, NEVER throws — one bad row
// must not blank the graph or break snapshot export.

import type {
  GraphEdge,
  GraphNode,
  GraphTopology,
  NodeReport,
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
  /** REAL `NodeReport` batches (e.g. `nodeReports()` from `native-probes`) —
   *  merged AFTER the adapters; a real report wins by id over a synthesized
   *  one. Optional: absent = adapter-only (today's production wiring). */
  reports?(): NodeReport[];
}

/** A registered node may name a LEGACY meter key its stats fold from (e.g.
 *  "tracking:kcf") — node ids and meter names converge (B-24), so new meters
 *  need no statsKey. */
export type WiredNode = GraphNode & { statsKey?: string };
export interface GraphWiring {
  nodes: WiredNode[];
  edges: GraphEdge[];
  /** DISPLAY-ONLY serial→role map ("L"/"C"/"R") for the leased camera triple —
   *  folded onto the served `GraphTopology.roles` so the profiler can label
   *  cameras by role. ABSENT for manage-cameras (serials are its identity). */
  roles?: Record<string, string>;
}

/** Adapter-internal report flavor: may carry an ALREADY-REDUCED badge (a
 *  `WiredNode.stats` passthrough) that wins over any fold. */
type AdapterReport = NodeReport & { badge?: NodeStats };

// Same threshold as the profiler's SATURATED styling (utilizationLevel "high").
const SATURATED_UTILIZATION = 0.9;

const wirings = new Set<GraphWiring>();

/** STAGE-1 SHIM: a session registers its fixed composition on activate; the
 *  disposer (drain) removes it. Superseded when sessions report `NodeReport`s
 *  directly (see the migration story above). */
export function registerGraphWiring(wiring: GraphWiring): () => void {
  wirings.add(wiring);
  return () => wirings.delete(wiring);
}

/** Reduce one workload snapshot to the node badge. */
function statsFrom(w: WorkloadSnapshot | undefined): NodeStats | undefined {
  if (!w) return undefined;
  let ratePerSec = 0;
  let maxIntervalMs = 0;
  // Defensive reads throughout: one malformed probe row must degrade to a
  // partial badge, never crash `perfSnapshot` (rig 2026-07-08: tracker/
  // converter rows without `drops` blanked the graph + broke export
  // everywhere). `nativeProbes()` normalizes, but wirings inject rows too.
  for (const s of Object.values(w.outputs ?? {})) {
    ratePerSec = Math.max(ratePerSec, s.ratePerSec ?? 0);
    maxIntervalMs = Math.max(maxIntervalMs, s.maxIntervalMs ?? 0);
  }
  return {
    utilization: w.utilization ?? 0,
    ratePerSec,
    maxIntervalMs,
    dropsPerSec: w.drops?.ratePerSec ?? 0,
    dropsTotal: w.drops?.total ?? 0,
    saturated: (w.utilization ?? 0) >= SATURATED_UTILIZATION,
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

// --- ADAPTER (a): Pipe.list() → NodeReports ---------------------------------

/** COMPAT ADAPTER — dies with the native `Topology.report()` NAPI (P3).
 *  Every advertised SHM pipe → a pipe-transport report; every
 *  `camera/<serial>/...` pipe also synthesizes its implicit raw-source root
 *  (`camera/<serial>`, native transport) and declares the PHYSICAL
 *  camera→brick input (see the header note on fused pipelines). */
export function pipeListToReports(pipes: PipeListRow[]): NodeReport[] {
  const cameras = new Map<string, NodeReport>();
  const reports: NodeReport[] = [];
  for (const pipe of pipes) {
    const segs = pipe.id.split("/");
    // `spec.dtype` is the canonical schema value at runtime; the list row types
    // it as plain string (structural seam) — trusted narrowing.
    const output = {
      kind: "frame",
      pixelFormat: pipe.spec.pixelFormat,
      dtype: pipe.spec.dtype,
    } as StreamType;
    const inputs: NodeReport["inputs"] = [];
    if (segs[0] === "camera" && segs[1]) {
      const camId = nodeId.camera(segs[1]);
      let cam = cameras.get(camId);
      if (!cam) {
        cam = {
          id: camId,
          kind: "camera",
          transport: "native",
          inputs: [],
          output: { kind: "frame", pixelFormat: "sensor", dtype: "U8" },
        };
        cameras.set(camId, cam);
      }
      inputs.push({ from: camId, port: "in", type: cam.output! });
    }
    reports.push({
      id: pipe.id,
      kind: kindOfPipeId(pipe.id),
      transport: "pipe",
      inputs,
      output,
      epoch: pipe.epoch,
      pipe: { consumers: pipe.consumers, bytesTotal: pipe.bytesTotal },
    });
  }
  return [...cameras.values(), ...reports];
}

// --- ADAPTER (b): registerGraphWiring entries → NodeReports ------------------

/** COMPAT ADAPTER — dies when sessions post `NodeReport`s directly. Wiring
 *  edges move into the TARGET node's `inputs` (edge ownership per §6); an edge
 *  targeting a node the wiring doesn't declare gets a minimal placeholder
 *  report (merged input-union with whichever layer really owns that id).
 *  `statsKey` folding preserved: the legacy meter row is attached as the
 *  report's stats; a pre-reduced `WiredNode.stats` badge rides `badge`. */
export function wiringToReports(
  entries: Iterable<GraphWiring>,
  workloads: Record<string, WorkloadSnapshot>,
): NodeReport[] {
  const reports = new Map<string, AdapterReport>();
  for (const wiring of entries) {
    for (const n of wiring.nodes ?? []) {
      if (!n || typeof n.id !== "string" || reports.has(n.id)) continue;
      const { statsKey, stats, ...node } = n;
      reports.set(n.id, {
        ...node,
        // WiredNode.transport is StreamTransport; "channel" never appears in
        // practice (wirings declare native/port/sink nodes) — pass through.
        transport: node.transport as NodeReport["transport"],
        inputs: [],
        badge: stats,
        stats: workloads[statsKey ?? n.id],
      });
    }
    for (const e of wiring.edges ?? []) {
      if (!e || typeof e.to !== "string" || typeof e.from !== "string") continue;
      let target = reports.get(e.to);
      if (!target) {
        // Placeholder: the edge's target lives in another layer (e.g. a
        // pipe-derived node) — the merge unions inputs into the real node.
        target = {
          id: e.to,
          kind: kindOfPipeId(e.to),
          transport: "native",
          inputs: [],
          output: null,
        };
        reports.set(e.to, target);
      }
      target.inputs.push({ from: e.from, port: e.port ?? "in", type: e.type });
    }
  }
  return [...reports.values()];
}

// --- The universal fold ------------------------------------------------------

export interface ReportFoldOpts {
  /** perfSnapshot workloads map — stats fold BY ID for report rows without
   *  their own `stats` (legacy `statsKey` is resolved by the wiring adapter). */
  workloads: Record<string, WorkloadSnapshot>;
  /** Snapshot wall time (epoch ms); defaults to `Date.now()`. */
  at?: number;
}

/** PRIMARY entry (unified-time-and-topology §6): fold `NodeReport`s into the
 *  served `GraphTopology`. Nodes = reports; edges = flatten(inputs); pipe
 *  reports with live consumers additionally grow an aggregate consumer-sink
 *  node (renderer views/one-shot readers connect anonymously via the broker —
 *  identity arrives with the compose protocol) whose edge carries the exact
 *  bytes-delta MB/s, keyed by (id, epoch). Malformed reports degrade, never
 *  throw. */
export function buildTopologyFromReports(
  reports: NodeReport[],
  opts: ReportFoldOpts,
): GraphTopology {
  const at = opts.at ?? Date.now();
  const workloads = opts.workloads ?? {};
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const list = (Array.isArray(reports) ? reports : []).filter(
    (r): r is NodeReport => !!r && typeof r.id === "string" && r.id !== "",
  );

  // Pass 1: index producers + compute each pipe's exact bytes-delta ONCE
  // (bytesRate is stateful — the same call also keeps the delta window warm
  // for consumer-less pipes).
  const byId = new Map<string, NodeReport>();
  const pipeBytesPerSec = new Map<string, number | undefined>();
  for (const r of list) {
    byId.set(r.id, r);
    const pipe = r.transport === "pipe" ? r.pipe : undefined;
    if (pipe && typeof pipe.bytesTotal === "number")
      pipeBytesPerSec.set(r.id, bytesRate(r.id, r.epoch ?? 0, pipe.bytesTotal, at));
  }
  const snapOf = (id: string): WorkloadSnapshot | undefined =>
    byId.get(id)?.stats ?? workloads[id];

  for (const r of list) {
    const snap = r.stats ?? workloads[r.id];
    nodes.set(r.id, {
      id: r.id,
      kind: typeof r.kind === "string" && r.kind ? r.kind : kindOfPipeId(r.id),
      output: r.output ?? null,
      transport: r.transport ?? "native",
      ...(r.owner !== undefined ? { owner: r.owner } : {}),
      ...(r.epoch !== undefined ? { epoch: r.epoch } : {}),
      // Mirror the pipe's live consumer refcount onto the node — the profiler's
      // positive "no downstream demand" (idle) signal for a parked pipe that
      // emits no consumer edge at 0 consumers.
      ...(r.transport === "pipe" && r.pipe ? { pipe: r.pipe } : {}),
      stats: (r as AdapterReport).badge ?? statsFrom(snap),
    });

    for (const input of Array.isArray(r.inputs) ? r.inputs : []) {
      if (!input || typeof input.from !== "string") continue; // degrade
      const port = typeof input.port === "string" ? input.port : "in";
      // TX = producer side (its output meter + pipe byte accumulator);
      // RX = this consumer's per-port input meter (exact port key when the
      // meter names ports the same way; falls back to the max input rate).
      const producer = byId.get(input.from);
      const producerSnap = snapOf(input.from);
      const txHz = outputRate(producerSnap);
      const txBytes = pipeBytesPerSec.get(input.from);
      const txGap = outputMaxIntervalMs(producerSnap);
      const rxStat = snap?.inputs?.[port];
      const rxHz = rxStat?.ratePerSec ?? inputRate(snap);
      const rxGap = rxStat?.maxIntervalMs ?? inputMaxIntervalMs(snap);
      // Lossy: declared by the consumer (Leaky/SHM subscriptions), defaulted
      // for SHM-pipe producers (seqlock reads are latest-wins by design).
      const lossy = input.lossy ?? producer?.transport === "pipe";
      const dropPerSec = !lossy
        ? undefined
        : txHz !== undefined && rxHz !== undefined
          ? Math.max(0, txHz - rxHz)
          : snap?.drops?.ratePerSec;
      // FIFO (lossless) edges report the consumer's high-water mark IN PLACE OF
      // a drop rate (controller-node-and-fifo-edges §2). Only when the consumer
      // snapshot carries a well-formed `queue`; explicit `input.lossy === false`
      // already defeats the pipe-producer default above so a FIFO input off a
      // pipe producer still lands here. Malformed queue → attribute absent.
      const queue = !lossy ? queueEdgeStat(snap) : undefined;
      edges.push({
        from: input.from,
        to: r.id,
        port,
        type: input.type,
        ...(txHz !== undefined || txBytes !== undefined || txGap !== undefined
          ? {
              tx: {
                ...(txHz !== undefined ? { hz: txHz } : {}),
                ...(txBytes !== undefined ? { bytesPerSec: txBytes } : {}),
                ...(txGap !== undefined ? { maxIntervalMs: txGap } : {}),
              },
            }
          : {}),
        ...(rxHz !== undefined || rxGap !== undefined
          ? {
              rx: {
                ...(rxHz !== undefined ? { hz: rxHz } : {}),
                ...(rxGap !== undefined ? { maxIntervalMs: rxGap } : {}),
              },
            }
          : {}),
        ...(lossy ? { lossy: true } : {}),
        ...(dropPerSec !== undefined ? { dropPerSec } : {}),
        ...(queue ? { queue } : {}),
        // Legacy mirror (deprecated): pre-tx/rx readers saw the consumer's
        // input rate here — unchanged during the migration.
        ratePerSec: rxHz,
      });
    }

    // Aggregate consumer sink for pipe reports with live consumers. RX is
    // unknowable until the compose protocol brings consumer identity
    // (anonymous broker reads) — TX carries the meterable half.
    const pipe = r.transport === "pipe" ? r.pipe : undefined;
    if (pipe && (pipe.consumers ?? 0) > 0) {
      const bytesPerSec = pipeBytesPerSec.get(r.id);
      const txHz = statsFrom(snap)?.ratePerSec;
      const txGap = outputMaxIntervalMs(snap);
      const sinkId = `${r.id}/consumers`;
      nodes.set(sinkId, {
        id: sinkId,
        kind: "view",
        output: null,
        transport: "sink",
      });
      edges.push({
        from: r.id,
        to: sinkId,
        port: "in",
        type: r.output ?? { kind: "analysis", schema: "unknown" },
        consumers: pipe.consumers,
        ...(txHz !== undefined || bytesPerSec !== undefined || txGap !== undefined
          ? {
              tx: {
                ...(txHz !== undefined ? { hz: txHz } : {}),
                ...(bytesPerSec !== undefined ? { bytesPerSec } : {}),
                ...(txGap !== undefined ? { maxIntervalMs: txGap } : {}),
              },
            }
          : {}),
        lossy: true, // SHM seqlock: consumers read latest-wins by design
        // Legacy mirrors (deprecated).
        ratePerSec: txHz,
        bytesPerSec,
      });
    }
  }

  return { seq: ++seq, at, nodes: [...nodes.values()], edges };
}

/** Consumer-side FIFO queue stats for a NON-lossy edge (§2): the trailing-10s
 *  high-water mark + capacity (+ last-sampled depth). Defensive — a partial or
 *  non-numeric `queue` degrades to `undefined`, never throws. */
function queueEdgeStat(
  w: WorkloadSnapshot | undefined,
): GraphEdge["queue"] | undefined {
  const q = w?.queue;
  if (!q || typeof q.highWater !== "number" || typeof q.capacity !== "number")
    return undefined;
  return {
    highWater: q.highWater,
    capacity: q.capacity,
    ...(typeof q.depth === "number" ? { depth: q.depth } : {}),
  };
}

/** Max output-stream rate of a snapshot (the producer-side Hz for TX). */
function outputRate(w: WorkloadSnapshot | undefined): number | undefined {
  if (!w) return undefined;
  let rate: number | undefined;
  for (const s of Object.values(w.outputs ?? {}))
    rate = Math.max(rate ?? 0, s.ratePerSec ?? 0);
  return rate;
}

/** Worst output gap over the capture window (producer-side maxInterval). */
function outputMaxIntervalMs(w: WorkloadSnapshot | undefined): number | undefined {
  if (!w) return undefined;
  let gap: number | undefined;
  for (const s of Object.values(w.outputs ?? {}))
    if (s.maxIntervalMs !== undefined) gap = Math.max(gap ?? 0, s.maxIntervalMs);
  return gap;
}

/** Worst input gap over the capture window (consumer-side fallback when the
 *  meter doesn't key its inputs by the edge's port name). */
function inputMaxIntervalMs(w: WorkloadSnapshot | undefined): number | undefined {
  if (!w) return undefined;
  let gap: number | undefined;
  for (const s of Object.values(w.inputs ?? {}))
    if (s.maxIntervalMs !== undefined) gap = Math.max(gap ?? 0, s.maxIntervalMs);
  return gap;
}

/** Merge report layers by id. WITHIN a layer the FIRST report of an id wins
 *  its node fields and later duplicates UNION their inputs in (a wiring
 *  placeholder targeting a pipe-derived node adds its edge without touching
 *  the node). ACROSS layers a later layer REPLACES an earlier one outright —
 *  node fields AND inputs — so a real `NodeReport` fully supersedes adapter
 *  synthesis (§6: the report knows its ACTUAL connections; no synthesized
 *  edges survive next to it). */
function mergeReportLayers(layers: NodeReport[][]): NodeReport[] {
  const merged = new Map<string, AdapterReport>();
  for (const layer of layers) {
    const seenThisLayer = new Set<string>();
    for (const r of Array.isArray(layer) ? layer : []) {
      if (!r || typeof r.id !== "string") continue;
      if (seenThisLayer.has(r.id)) {
        unionInputs(merged.get(r.id)!, r); // same-layer dup: first wins fields
        continue;
      }
      seenThisLayer.add(r.id);
      merged.set(r.id, { ...r, inputs: [...inputsOf(r)] }); // later layer replaces
    }
  }
  return [...merged.values()];
}

function inputsOf(r: NodeReport): NodeReport["inputs"] {
  return Array.isArray(r.inputs) ? r.inputs : [];
}

function unionInputs(target: AdapterReport, source: NodeReport): void {
  for (const input of inputsOf(source)) {
    if (!input || typeof input.from !== "string") continue;
    const dup = target.inputs.some(
      (i) => i.from === input.from && i.port === input.port,
    );
    if (!dup) target.inputs.push(input);
  }
}

// --- Legacy entry (unchanged signature/behavior) ------------------------------

/** Thin composition kept for `system.ts`/`index.ts`: adapters → real reports
 *  (win by id) → the universal fold. Signature and served behavior are
 *  IDENTICAL to pre-v2 — the regression tests pin the adapter output. */
export function buildTopology(deps: TopologyDeps): GraphTopology {
  const at = deps.now?.() ?? Date.now();
  const workloads = deps.workloads();
  let real: NodeReport[] = [];
  try {
    real = deps.reports?.() ?? [];
  } catch {
    // real reports must never take the adapter-derived graph down
  }
  const reports = mergeReportLayers([
    [...pipeListToReports(deps.listPipes()), ...wiringToReports(wirings, workloads)],
    real,
  ]);
  const topo = buildTopologyFromReports(reports, { workloads, at });
  const roles = collectRoles(wirings);
  return roles ? { ...topo, roles } : topo;
}

/** Union the DISPLAY-ONLY serial→role maps across all registered wirings (a
 *  camera-owning app session publishes one; manage-cameras publishes none).
 *  Defensive — non-string entries are skipped, never thrown on. */
function collectRoles(entries: Iterable<GraphWiring>): Record<string, string> | undefined {
  let roles: Record<string, string> | undefined;
  for (const w of entries) {
    if (!w?.roles) continue;
    for (const [serial, role] of Object.entries(w.roles))
      if (typeof serial === "string" && typeof role === "string") (roles ??= {})[serial] = role;
  }
  return roles;
}

function inputRate(w: WorkloadSnapshot | undefined): number | undefined {
  // `undefined` (not 0) when the meter declares NO input channels — mirrors
  // `outputRate`. A meter that doesn't observe its inputs (the controller's
  // serial meter: `inputs: []`) must not claim a 0 Hz rx for edges into its
  // node; that read as "controller input edge: 0Hz" during live control.
  if (!w) return undefined;
  let rate: number | undefined;
  for (const s of Object.values(w.inputs ?? {}))
    rate = Math.max(rate ?? 0, s.ratePerSec ?? 0);
  return rate;
}

function bytesRate(
  id: string,
  epoch: number,
  bytesTotal: number,
  at: number,
): number | undefined {
  const prev = bytesPrev.get(id);
  bytesPrev.set(id, { epoch, bytes: bytesTotal, at });
  if (!prev || prev.epoch !== epoch || at <= prev.at) return undefined;
  const dBytes = bytesTotal - prev.bytes;
  if (dBytes < 0) return undefined;
  return (dBytes * 1000) / (at - prev.at);
}

/** Test hook: reset the module-level delta/seq state between cases. */
export function resetTopologyStateForTest(): void {
  bytesPrev.clear();
  wirings.clear();
  seq = 0;
}
