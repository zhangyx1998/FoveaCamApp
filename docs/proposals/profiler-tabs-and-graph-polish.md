# Profiler tabs + node-graph polish

Status: **PROPOSED (ruled 2026-07-10).** Renderer-only (`app/src/profiler/**`
— the sandboxed profiler window); no orchestrator/wire changes.

## User rulings (2026-07-10)

1. **Edges are cubic béziers** whose stems are ALIGNED ON NODE ENDPOINTS —
   the curve must leave the source node and enter the target node
   perpendicular to the node edge it attaches to (no oblique stubs).
2. **The profiler window splits into tabs** — it has grown into a ~12-section
   scroll over the iterations and needs cleaner grouping.
3. **Node statistics move INTO the graph** — e.g. busy percentage as a
   circular indicator per node — with full details demoted to a hover
   popup per node and per edge.

## 1 — Edge geometry (GraphPanel.vue / graph-view.ts)

Today: cytoscape `unbundled-bezier` with per-edge `control-point-distances`
— tangents at the endpoints follow the control points, so stems meet nodes
at arbitrary angles.

Target: per-edge CUBIC control points computed from the attachment
geometry — first control point offset from the source attachment point
along the source node-edge NORMAL, second offset from the target attachment
point along the target node-edge normal (offset magnitude scaled by edge
length, clamped). Pin attachment sides via `source-endpoint` /
`target-endpoint` so LR-ranked layouts attach left/right faces (matching
the existing LR endpoint convention) and the arrowhead + stem enter
perpendicular. Keep the existing hover/drop/backpressure edge styling.

## 2 — Tabs (ProfilerWindow.vue)

Fixed header (report rate, pin, snapshot reveal, session banner) above a
tab strip — the Settings two-tab restructure is the shell precedent.
Proposed grouping of the current sections (worker may refine; record the
final grouping in AS SHIPPED):

| Tab | Sections |
|---|---|
| **Graph** | Pipeline graph (primary, gets the vertical space freed by the split) |
| **Workloads** | Workloads table, Event-loop lag |
| **Control** | Control-path latency, Volt telemetry, Serial data rate |
| **Transport** | Live streams, Per-topic channel rates, Store-hub writes |
| **System** | Clocks, Boot / activation timeline |

Active tab persists across reloads (`?win=` URL-state or `local.ts`
localStorage ref — follow whichever precedent fits the profiler's existing
state handling). Passive-subscription behavior must NOT change (the
profiler still never activates hardware; all tabs render from the same
1 Hz `perfSnapshot`).

## 3 — In-graph statistics + hover popups

- Each graph node gets a compact **circular busy indicator** (ring/arc fed
  by the node's utilization from the folded workload stats — the same value
  the Workloads table shows; SATURATED ≥ 0.9 keeps its warning treatment).
  Cytoscape pie/ring background or SVG-data-URI background — worker's
  choice, but it must track live snapshots without relayout.
- Node labels stay minimal (id/kind + rate); everything else (counters,
  busy ms, util, drops, queue depth, clock rows) moves to a **hover popup**
  anchored to the node/edge under the cursor (positioned DOM card over the
  canvas, hidden on leave/pan/zoom). Edges get the same treatment (tx/rx
  rates, drop/backpressure detail, max inter-arrival).
- The Workloads tab keeps the full sortable table — the popup is a lens,
  not the archive.
- Follow `docs/design/design-language.md` (dark-lab operator: high
  information density, restrained color, no decorative chrome).

## Non-goals

- No change to `perfSnapshot` shape, graph-contract, metering, or anything
  orchestrator-side.
- No new graph library — stay on cytoscape.
- No reflow of the folded stats pipeline (`graph-view.ts` fold logic) beyond
  what the indicators/popups need to read.

## Verification (software)

- vue-tsc, vitest (graph-view fold tests unaffected or updated), vite build.
- RIG-GATED (bench session): live-graph readability under real load —
  perpendicular stems at every node, busy rings tracking the Workloads
  table, popups matching table values, tab state surviving reload.
