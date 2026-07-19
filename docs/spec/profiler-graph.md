# Profiler graph & workloads — behavior spec

Behavior contracts for the profiler window's view-model layer
(`app/src/profiler/**`). Source files carry `// spec:` pointers here. The graph
topology contract lives in `@lib/orchestrator/graph-contract`. The pipeline graph
is a HANDROLLED SVG component (`app/src/components/NodeGraph.vue`); the layered
layout (`graph-layout.ts`) and viewport algebra (`graph-viewport.ts`) are pure,
unit-tested modules. The whole view-model + geometry layer is Vue-free and DOM-free
by design so the decision logic is unit-tested; the Vue components keep only thin
event wiring + rendering.

## Topology source selection {#topology-source}

`graph-view.ts`. Two-stage source:

- **Stage 2 (preferred)** — the orchestrator-SERVED topology:
  `graphTopology()` riding `PerfSnapshot.graph` (exact byte rates, consumer sinks,
  session wirings). `selectTopology` prefers it.
- **Stage 1 (fallback + mock story)** — `deriveTopology` reconstructs a
  `GraphTopology` from today's observable surfaces: interval-diffed `WorkloadRow`s
  + the advertised `PipeAdvert` record + static wiring knowledge. Every workload row
  lands on the graph (matched rows attach stats to a structural node; unmatched rows
  become standalone nodes keyed by their path-ified name — a meter must never be
  invisible because its name pattern is new). The fallback thunk is evaluated only on
  the fallback path.

Node id scheme: pipe ids ARE path-like node ids —
`camera/<serial>/convert`, `camera/<serial>/undistort`,
`camera/<serial>/undistort/fovea/<slot>`. `kindOf` takes the last non-numeric
segment. Meter names containing `/` (and not `:`) are path-like node ids attached
directly; names with `:` are legacy families (`controller:*`, `recorder:*`,
`viewer:*` → sinks) until their nodes migrate.

## Element reduction {#elements}

`toElements` reduces a topology to `GraphElement[]` (pure data — the component
diffs by element id). It applies two display normalizations, BOTH here so
`membershipKey` sees the same graph: SHM consumer-sink collapse, then idle
derivation. Dangling edges are skipped defensively. Node data carries `id`,
`kind`, `label`, `detail`, optional `util` (0..1) and `roleColor`; edge data
carries `source`, `target`, `label`, `lane`, `lanes`; the `classes` string
carries `idle` / `saturated` / `dropping`.

- **Labels** — `nodeLabel`: in an application context a leased camera shows its
  ROLE (L/C/R from `GraphTopology.roles`) instead of its serial; middleware shows
  `<role>/<action>` with no upstream breadcrumb (the edges already carry the chain).
  Metrics live in the hover card (`nodeDetail`/`edgeDetail`), keyed on the full id.
- **Role color** — `ROLE_COLORS` (L cyan / C orange / R greenyellow) mirrors
  `tokens.css --role-*`; a border tint only (fills stay kind-colored). Passed
  through element data (`roleColor`) and bound to a CSS custom property on the
  node; `KIND_COLORS` likewise seeds the `--kind` fill.
- **Busy ring** — metered nodes carry their raw `util` (0..1); the
  component draws a NATIVE SVG arc (`<circle>` with `stroke-dasharray`) pinned to
  the node's top-right corner, filling clockwise to `util` and tiered by the SAME
  ok/warn/high thresholds as the Workloads table (saturated ≥ 0.9 → coral). Fed
  live from each 1 Hz snapshot with no relayout.

## Membership key (relayout gating) {#membership}

`membershipKey` — layout re-runs ONLY when this changes. Normalized through
`collapseConsumerSinks` so it sees the same node/edge set the panel renders (a
stats-only refresh whose consumer count wiggles must not churn layout). Nodes keyed
by `(id, epoch)` per the contract (an epoch bump = a re-created node = worth a
relayout); stats deliberately excluded. Stats-only refreshes at 1 Hz must never
move nodes.

## Consumer-sink collapse {#consumer-collapse}

`collapseConsumerSinks` — the anonymous per-pipe SHM consumer sinks
(`<pipeId>/consumers`, kind "view"/transport "sink") collapse into ONE shared
`renderer` node. Each consuming pipe keeps its OWN fan-in edge (rate + consumer
refcount preserved in the edge detail), so the graph loses N anonymous sinks
without losing any flow info. Real orchestrator-side consumers (workers, recorder,
capture, `win/` nodes) are not sinks matching the pattern and pass through.
Idempotent + reference-stable when there is nothing to collapse.

## Idle vs stalled derivation {#idle}

`deriveIdle` — IDLE = not running because nothing downstream DEMANDS the output (a
consumer-gated producer parked by design). An EXPECTED state: renders
desaturated + dimmed with an "idle" caption, NOT the red stalled accent. Positive
no-demand evidence, propagated UPSTREAM over the topology:

- a pipe node whose `pipe.consumers === 0` (zero SHM subscribers — a 0-consumer
  pipe emits no consumer edge, so the count rides the node) and no live
  native/worker consumer;
- an explicit `consumers === 0` on a consumer edge (the aggregate sink);
- a node all of whose downstream consumers are themselves idle (hollow demand).

Conversely: a pipe with `pipe.consumers > 0` is DEMANDED. A node with a positive
rate — or positive utilization / saturated — is NEVER idle (demonstrably spinning
or burning CPU; a pegged node that emits nothing is a STALL and keeps its red).
Demand that can't be positively DISPROVEN defaults to LIVE — never invent idle, a
false "idle" would hide a real stall. The traversal is mutually recursive over the
DAG with a cycle guard (PID feedback loops → treated as demanded, never
false-idle); idle and saturated are mutually exclusive by construction.

## Edge semantics {#edges}

- `edgeLabel` — the EFFECTIVE rate only: `min(tx, rx)` when both directions are
  metered (the slower side is what downstream receives), else the single metered
  direction. Bytes/s, worst gaps, drops, and consumers live in the hover card.
- `isDropping` — a lossy (latest-wins) link actually dropping; `isBackpressured` —
  a FIFO (lossless) link whose consumer queue hit capacity over the window (it
  actually blocked its producer). `edgeWarns` = either → the always-on red
  `edge.dropping` styling. FIFO edges show the high-water mark IN PLACE OF the drops
  row (drops and queue are mutually exclusive in practice).
- `edgeLanes` — same-direction parallel edges (identical `from`→`to`, distinct
  port) fan onto small vertical attachment offsets so the perpendicular stems stay
  parallel instead of overlapping. Bidirectional pairs already separate via their
  opposite L/R faces.

## Hover focus {#hover}

`hoverDistances` — BFS hop distance from the hovered element over the INCIDENCE
graph (a node is adjacent to its incident edges; an edge to its two endpoints).
Drives the hover opacity gradient + z-order (nearest on top). Unreachable elements
are ABSENT from the map (the caller floors them to `HOVER_OPACITY_FLOOR`); an
unknown hovered id (churned away mid-hover) → EMPTY map = "clear hover", never
fades the whole graph. `effectiveOpacity` = `min(idle-resting, hover-distance)` so
idle stays capped at `IDLE_OPACITY` no matter how near the hover.

## Workloads table {#workloads}

`workload-view.ts` — pure snapshot→view-model transform.
Takes the current + previous `perfSnapshot.workloads` (already polled at 1 Hz and
kept for the channel-rate table — same inputs, no new wire messages) and derives
INTERVAL utilization/rates by diffing the two, falling back to the meter's own
cumulative numbers when there is nothing to diff. Why diff: snapshot rates are
cumulative since registration (honest but slow-moving — an all-night registry loop
averages the night in); a live profiler wants "what happened in the last poll
tick." Time comes from each snapshot's `window.snapshotAt`, never `Date.now()`, so
it stays testable. `maxIntervalMs` is the largest inter-arrival interval
over the trailing 10 s; `stalled` = it exceeds `STALL_FACTOR` × the stream's
nominal period — the "obvious bad value" highlight.

## Rendering + interactions {#layout}

`NodeGraph.vue` renders the reduced `GraphElement[]` as native SVG and owns every
interaction; `GraphPanel.vue` is a thin adapter (topology → `toElements`, reads
the hover-card config, hosts `<NodeGraph>`). The container fills its parent
100%/100% and never scrolls. One `<g transform="translate(pan) scale(zoom)">`
applies the viewport (screen = model · zoom + pan), so everything below is drawn in
model space.

- **Nodes** — `<rect rx>` + multiline `<text>`; kind fill (`--kind`), role border
  tint (`--role`), saturated red, idle desaturation as CSS; the busy-ring arc
  overhangs the top-right corner. Node sizes are ESTIMATED pre-render from label
  metrics (monospace ~9px, ~5.4px/char + padding, clamped to a max width) to seed
  the layout and draw the pill.
- **Edges** — `<path>` from `graph-interactions.edgePath` (cubic with horizontal
  tangents; source right face → target left face, `laneOffset` fanning for
  same-direction parallels), an arrowhead marker (`context-stroke` so warn/idle
  edges match), and a rate label with a background rect. `.dropping` = warn red,
  `.idle` = static dashed + desaturated.
- **Layout** (`graph-layout.layoutDag`, LR Sugiyama-lite) re-runs ONLY on
  membership change (node/edge id set) — the 1 Hz stats refresh never re-scrambles
  a placed node. `reconcileDraggedPositions` re-applies surviving user-dragged
  positions over the fresh auto-layout (auto owns every untouched node).
- **Drag** — pointer events move a node's model position LIVE; edge paths recompute
  every pointermove, positions being reactive.
- **Pan / zoom** (`graph-viewport`) — plain wheel = X/Y pan via `panBy` (clamped so
  the canvas-center model point stays inside the graph bbox; macOS
  two-finger trackpad pan works natively). `ctrl+wheel` (= macOS pinch, gated by
  `isZoomGesture`) = `zoomAt` centered on the pointer (`nextZoomLevel`).
  No whitespace-drag panning.
- **Viewport resize** — a `ResizeObserver` drives `resizeViewport`
  (`viewportContent` refit + `clampPan`) on window resize, fullscreen enter/exit,
  and the tab reveal; the FIRST non-zero box fits the whole graph.
- **Marching dash** — hover-highlighted (BFS distance ≤ 1) NON-idle
  edges get a `stroke-dashoffset` keyframe marching source → target; idle edges
  keep their static dash (no flow to animate).
- **Chips** — fit / reset layout (also clears dragged + refits) /
  fullscreen (Fullscreen API on the component root).

## Hover card + config {#hover-card}

The hover-detail card (structured `HoverDetail` title + label/value rows) is
positioned by the pure `hover-card-placement.ts` module, chosen by the app-wide
`profiler_hover_card` config entry (`config-schema.ts`:
`PROFILER_HOVER_CARD_MODES` / `coerceProfilerHoverCardMode`, default `follow`;
surfaced in Settings → Global; the profiler window reads it live over the shared
config doc):

- `followPlacement` (`follow`) — the card tracks the cursor, preferring
  below-right, flipping horizontally/vertically whenever it would overflow the
  container (four-quadrant flip), updated on every pointermove.
- `cornerPlacement` (`corner`) — the card snaps to the container corner (+ margin)
  whose rect covers the hovered element LEAST (ties → farthest from the cursor).

Both clamp gracefully in a degenerate tiny container.

## Interaction helpers {#interactions}

`graph-interactions.ts` — pure geometry + gating shared by the graph component:
ctrl-wheel zoom gating (`isZoomGesture` — macOS trackpad pinch arrives as a wheel
event with `ctrlKey: true`, same path; plain wheel pans), `nextZoomLevel`
(multiplicative, clamped), the perpendicular-stem `edgePath` + `stemOffset` /
`laneOffset` geometry, `reconcileDraggedPositions`, and ProfilerWindow's
configurable report rate. Canonical `ZOOM_MIN` / `ZOOM_MAX` live in
`graph-viewport.ts` (re-exported here).

## Per-instance binding {#binding}

`binding.ts` — pure presentation helpers for the profiler's per-instance binding.
A profiler pins AT OPEN to exactly one orchestrator instance; the binding rides the
URL (`instance` + `session` params) and is immutable for the window's life. When
its instance dies the profiler freezes with its accumulated data and NEVER
re-attaches to a newer instance. `shortInstanceId` compacts a long id to
its trailing 6 chars; `profilerSubtitle` reads `<session> · #<id>`, or "no active
session" when unbound. See also [windows.md#profiler-binding](./windows.md#profiler-binding).
