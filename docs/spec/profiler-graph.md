# Profiler graph & workloads — behavior spec

Behavior contracts for the profiler window's view-model layer
(`app/src/profiler/**`). Source files carry `// spec:` pointers here. Governing
docs: `docs/history/refactor/workload-metering.md`,
`docs/proposals/orchestrator-lifecycle-and-exit.md`, and C-24's
`@lib/orchestrator/graph-contract`. The whole view-model layer is Vue-free,
DOM-free, and cytoscape-free by design so the decision logic is unit-tested; the
Vue components keep only thin event wiring + rendering.

## Topology source selection {#topology-source}

`graph-view.ts`. Two-stage source:

- **Stage 2 (preferred, A-36)** — the orchestrator-SERVED topology: C-24's
  `graphTopology()` riding `PerfSnapshot.graph` (exact byte rates, consumer sinks,
  session wirings). `selectTopology` prefers it.
- **Stage 1 (fallback + mock story)** — `deriveTopology` reconstructs a
  `GraphTopology` from today's observable surfaces: interval-diffed `WorkloadRow`s
  + the advertised `PipeAdvert` record + static wiring knowledge. Every workload row
  lands on the graph (matched rows attach stats to a structural node; unmatched rows
  become standalone nodes keyed by their path-ified name — a meter must never be
  invisible because its name pattern is new). The fallback thunk is evaluated only on
  the fallback path.

Node id scheme (C-24): pipe ids ARE path-like node ids —
`camera/<serial>/convert`, `camera/<serial>/undistort`,
`camera/<serial>/undistort/fovea/<slot>`. `kindOf` takes the last non-numeric
segment. Meter names containing `/` (and not `:`) are path-like node ids attached
directly; names with `:` are legacy families (`controller:*`, `recorder:*`,
`viewer:*` → sinks) until their nodes migrate.

## Cytoscape reduction {#elements}

`toElements` reduces a topology to cytoscape element definitions (pure data — the
panel diffs by element id). It applies two display normalizations, BOTH here so
`membershipKey` sees the same graph: SHM consumer-sink collapse, then idle
derivation. Dangling edges are skipped defensively.

- **Labels** — `nodeLabel`: in an application context a leased camera shows its
  ROLE (L/C/R from `GraphTopology.roles`) instead of its serial; middleware shows
  `<role>/<action>` with no upstream breadcrumb (the edges already carry the chain).
  Metrics live in the hover card (`nodeDetail`/`edgeDetail`), keyed on the full id.
- **Role color** — `ROLE_COLORS` (L cyan / C orange / R greenyellow) mirrors
  `tokens.css --role-*`; a border tint only (fills stay kind-colored). Cytoscape's
  JS stylesheet can't read CSS custom properties, so values are mirrored in JS (same
  reason for `KIND_COLORS` and the ring colors).
- **Busy ring** (ruling 3) — `busyRing`: a thin arc filling clockwise to
  `utilization`, tiered by the SAME ok/warn/high thresholds as the Workloads table
  (saturated ≥ 0.9 → coral). Returned as an SVG `data:` URI for a corner
  `background-image` — ADDITIVE over the kind/saturated fill; fed live via
  `data(ring)` so it tracks each 1 Hz snapshot with no relayout.

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
consumer-gated producer parked by design, C-21 gate). An EXPECTED state: renders
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

`workload-view.ts` — pure snapshot→view-model transform (workload-metering.md §4).
Takes the current + previous `perfSnapshot.workloads` (already polled at 1 Hz and
kept for the channel-rate table — same inputs, no new wire messages) and derives
INTERVAL utilization/rates by diffing the two, falling back to the meter's own
cumulative numbers when there is nothing to diff. Why diff: snapshot rates are
cumulative since registration (honest but slow-moving — an all-night registry loop
averages the night in); a live profiler wants "what happened in the last poll
tick." Time comes from each snapshot's `window.snapshotAt`, never `Date.now()`, so
it stays testable. `maxIntervalMs` (C-18) is the largest inter-arrival interval
over the trailing 10 s; `stalled` = it exceeds `STALL_FACTOR` × the stream's
nominal period — the "obvious bad value" highlight.

## Interaction helpers {#interactions}

`graph-interactions.ts` — pure logic behind GraphPanel's canvas interactions:
persisted vertical resize (`clampGraphHeight`/`parseGraphHeight` — clamp to MIN,
integral, NaN/Infinity-safe), ctrl-wheel zoom gating (`isZoomGesture` — macOS
trackpad pinch arrives as a wheel event with `ctrlKey: true`, same path; plain
scroll falls through so the page scrolls), dragged-position preservation, and
ProfilerWindow's configurable report rate.

## Per-instance binding {#binding}

`binding.ts` — pure presentation helpers for the profiler's per-instance binding.
A profiler pins AT OPEN to exactly one orchestrator instance; the binding rides the
URL (`instance` + `session` params) and is immutable for the window's life. When
its instance dies the profiler freezes with its accumulated data and NEVER
re-attaches to a newer instance (ruling 2). `shortInstanceId` compacts a long id to
its trailing 6 chars; `profilerSubtitle` reads `<session> · #<id>`, or "no active
session" when unbound. See also [windows.md#profiler-binding](./windows.md#profiler-binding).
