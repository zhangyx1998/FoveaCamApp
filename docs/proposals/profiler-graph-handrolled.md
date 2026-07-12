# Profiler node graph — handrolled SVG rework (2026-07-12)

User-ruled rework of the profiler graph panel. Verdict on the npm question
first, then the ruled behavior changes, then the pinned module APIs the
implementation waves build against.

## Rulings (user, 2026-07-12)

1. Drop the graph-rendering npm package if it isn't earning its keep (it
   isn't — see assessment). Handrolled node graph becomes ITS OWN component.
2. Edges must re-lay on EVERY drag event (live), not on drag end.
3. The graph is inside a profiler tab now: the container is NOT resizable —
   it fills the tab container (unscrollable) and auto-scales with the
   profiler window. The height drag-handle + persistence die.
4. Pan = X/Y SCROLL (macOS trackpad pans natively via wheel deltas), not
   whitespace drag. Pan range clamped: the model point at the CANVAS CENTER
   must always lie within the graph bbox.
5. `viewportContent` bbox := intersection(viewport box, graph bbox), model
   space. On container resize (window resize, fullscreen enter/exit, tab
   reveal) the previous `viewportContent` must FIT the new container (contain
   fit), then clamp.
6. Zoom (ctrl+wheel; macOS pinch arrives as ctrl+wheel) centers on the
   POINTER location.
7. Highlighted ACTIVE edges animate with a marching-dash flow (source →
   target direction). Idle edges never march.
8. Hover detail card gets TWO behaviors behind an app-wide config entry:
   (a) `follow` — follows the cursor, quadrant-flipped (TL/TR/BL/BR) to
   avoid overflowing the graph container; (b) `corner` — snaps to a
   container corner with a small margin, choosing a corner that does not
   cover the hovered element (or the cursor).

## Assessment: is cytoscape necessary? (user question)

**No.** `cytoscape` + `cytoscape-dagre` (+ `@types/cytoscape-dagre`) are used
by exactly one feature — this panel — and roughly half of GraphPanel.vue is
code *fighting* the library: busy rings rendered as SVG-in-data-URI
background images because the canvas renderer can't read CSS custom
properties; `z-index-compare: manual` + inline-style re-stamping because
class rewrites clobber hover state; cursor management by hand because it's
one opaque `<canvas>`; perpendicular-stem control points decomposed into
cytoscape's `(weight, distance)` endpoint basis instead of just emitting a
cubic path; `as unknown as` casts where the bundled d.ts lags the runtime.
Every NEW ruling above (live drag re-lay, scroll pan, pointer-centered zoom,
pan clamping, viewportContent refit, marching dashes, smart hover cards) is
*harder* through cytoscape and *trivial* in handrolled SVG: an edge is a
`<path d="M … C …">` whose `d` recomputes reactively from node positions,
and the dash march is one CSS keyframe on `stroke-dashoffset`.

What cytoscape actually provided was dagre's layered layout. That is the
one genuinely non-trivial piece to hand-roll — assessed next.

## Assessment: handrolled auto-layout complexity (user question)

**Moderate — ~200 lines of pure TS, unit-testable.** Our graphs are sparse
LR pipeline DAGs (10–50 nodes: camera chains fanning to sinks, plus the
control lane with ONE feedback cycle). A Sugiyama-lite pass covers them:

1. **Ranking** — longest-path rank over the DAG; cycles tolerated by
   ignoring DFS back-edges for ranking (the PID feedback edge still renders,
   it just doesn't constrain ranks). Sources at rank 0.
2. **Ordering** — barycenter sweeps (down then up, ~4 passes) to reduce
   crossings within ranks; ties broken by id for determinism.
3. **Coordinates** — x from cumulative rank widths + rankSep; y stacks each
   rank's nodes with nodeSep, then a median-alignment pass pulls single-
   parent chains straight. Disconnected components stack vertically.

dagre wins on dense/pathological graphs; ours never are, and determinism +
testability + zero dependency beat generality here.

## Architecture

- **`app/src/components/NodeGraph.vue`** (NEW, self-contained component):
  SVG renderer + all interactions (drag with live edge re-lay, scroll pan,
  pointer zoom, fit/reset/fullscreen chips, hover cards, marching dash).
  Props: `elements: GraphElement[]`, `hoverCardMode: "follow" | "corner"`.
  Node visuals keep today's semantics: kind fills, role border tints,
  saturated red, idle desaturation, distance-graded hover opacity, busy ring
  (now a NATIVE `<circle stroke-dasharray>` arc — `busyRing`'s data-URI
  dies), edge labels with the effective rate, warn/idle edge styling.
- **`GraphPanel.vue`** shrinks to a thin adapter: topology → `toElements`,
  config read, hosts `<NodeGraph>`.
- **`graph-view.ts`** stays the pure reduction layer; the `ring` data-URI
  field is replaced by raw `util?: number` (+ existing saturated class) so
  the component draws the arc natively.
- **`graph-layout.ts`** (NEW, pure) — the Sugiyama-lite above.
- **`graph-viewport.ts`** (NEW, pure) — viewport algebra (below).
- **`graph-interactions.ts`** keeps zoom gating + stem/lane geometry, gains
  `edgePath()`, loses the cytoscape control-point decomposition and the
  whole graph-height block (panel no longer resizable).
- **cytoscape, cytoscape-dagre, @types/cytoscape-dagre** removed from
  app/package.json.

## Pinned pure APIs (implementation contract)

```ts
// graph-layout.ts
export interface LayoutNode { id: string; width: number; height: number }
export interface LayoutEdge { from: string; to: string }
export interface LayoutOptions { rankSep?: number; nodeSep?: number; padding?: number }
export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>; // node CENTERS, model px
  bbox: Box; // tight bbox over node extents + padding
}
export function layoutDag(nodes: LayoutNode[], edges: LayoutEdge[],
                          opts?: LayoutOptions): LayoutResult;

// graph-viewport.ts — screen = model · zoom + pan
export interface Box { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export interface Viewport { zoom: number; pan: { x: number; y: number } }
export const ZOOM_MIN: number; export const ZOOM_MAX: number;
export function intersect(a: Box, b: Box): Box | null;
export function viewportBox(vp: Viewport, container: Size): Box;      // visible model box
export function viewportContent(vp: Viewport, container: Size,
                                graph: Box): Box | null;              // ruling 5
export function clampPan(vp: Viewport, container: Size, graph: Box): Viewport; // ruling 4
export function panBy(vp: Viewport, dx: number, dy: number,
                      container: Size, graph: Box): Viewport;         // clamped
export function zoomAt(vp: Viewport, nextZoom: number,
                       pointer: { x: number; y: number },             // container-rel px
                       container: Size, graph: Box): Viewport;        // ruling 6, clamped
export function fitBox(target: Box, container: Size, pad?: number): Viewport; // contain+center
export function resizeViewport(vp: Viewport, prev: Size, next: Size,
                               graph: Box): Viewport;                 // ruling 5 refit
```

`resizeViewport` semantics: `content = viewportContent(vp, prev, graph)`
(whole graph when null/degenerate) → `fitBox(content, next)` → `clampPan`.
First reveal from a 0×0 box fits the whole graph bbox.

```ts
// graph-interactions.ts (kept/added)
isZoomGesture, nextZoomLevel, ZOOM rate constants          // unchanged
stemOffset, laneOffset                                      // unchanged
export function edgePath(s: {x,y}, t: {x,y}): string;
// cubic with horizontal tangents: off = stemOffset(|t−s|),
// "M s C (s.x+off, s.y) (t.x−off, t.y) t" — replaces the cytoscape
// (weight, distance) decomposition, which is DELETED with the library.
reconcileDraggedPositions                                   // unchanged
// DELETED: GRAPH_HEIGHT_KEY, DEFAULT/MIN_GRAPH_HEIGHT,
// clampGraphHeight, parseGraphHeight, perpendicularControlPoints
```

Hover-card placement is its own pure module (owned by the component wave):

```ts
// hover-card-placement.ts
export type HoverCardMode = "follow" | "corner";
export function followPlacement(cursor: {x,y}, card: Size, container: Size,
                                offset?: number): { x: number; y: number };
// quadrant auto-flip: prefer BR of cursor; flip horizontally/vertically
// whenever the card would overflow the container.
export function cornerPlacement(item: Box /* hovered element, container-rel */,
                                cursor: {x,y}, card: Size, container: Size,
                                margin?: number): { x: number; y: number };
// pick the corner (TL/TR/BL/BR + margin) whose card rect overlaps the
// hovered item bbox least (ties: farthest from cursor).
```

## Config entry (ruling 8)

`config-schema.ts`: `PROFILER_HOVER_CARD_MODES = ["follow", "corner"]`,
`type ProfilerHoverCardMode`, `DEFAULT_PROFILER_HOVER_CARD_MODE = "follow"`,
`coerceProfilerHoverCardMode()` — same idiom as `RecordCompression`. Doc key
`profiler_hover_card`. Surfaced in the Settings window next to the existing
app-wide entries; the profiler window reads it live via the shared config
doc (same broadcast path as every other entry).

## Marching dash (ruling 7)

Applied to hover-HIGHLIGHTED edges (BFS distance ≤ 1 from the hovered
element) that are NOT idle: `stroke-dasharray` + a `stroke-dashoffset`
keyframe marching source → target. Warn-red edges keep their color, idle
edges keep their static dash (no march — no flow to animate).

## What deliberately does NOT change

`toElements` semantics (collapse, idle derivation, lanes), `membershipKey`
relayout gating, dragged-position preservation across relayouts, hover
distance/opacity math, kind/role color identities, chips (fit / reset /
fullscreen), the empty-state caption, the 1 Hz stats-refresh-without-relayout
property, spec doc `docs/spec/profiler-graph.md` (updated in place, stays
the spec).

## AS SHIPPED (2026-07-12, two-lane wave)

Everything above landed as specified; vue-tsc / vitest 1243 / vite build /
check-boundaries green; cytoscape, cytoscape-dagre and @types/cytoscape-dagre
removed (app/package.json — the root lockfile is untracked; on-disk refresh
verified cytoscape-free). The profiler window renderer chunk is ~43 KB total
(the cytoscape bundle alone was an order of magnitude larger).

- Pure lane: `graph-layout.ts` (388 lines incl. docs — ranking, barycenter,
  median alignment, component stacking), `graph-viewport.ts` (fitBox zoom
  capped at FIT_ZOOM_MAX = 2; canonical ZOOM_MIN/MAX moved here,
  re-exported by graph-interactions), `edgePath()` in graph-interactions
  (perpendicularControlPoints + the whole graph-height block deleted),
  graph-view `ring` → raw `util`. 34 new unit tests.
- Component lane: `NodeGraph.vue` (SVG, self-contained),
  `hover-card-placement.ts` (+10 tests), GraphPanel.vue → 45-line adapter,
  ProfilerWindow graph tab fills (`.no-scroll` on the graph tab only),
  `profiler_hover_card` config entry (Settings → Global tab, after
  "Auto-close empty projections"), spec updated in place.
- Node sizes are ESTIMATED pre-render (monospace ~5.4 px/char, clamped
  28–172 px wide) instead of DOM-measured — labels are single-line in
  practice; layout stays synchronous.
- Planner fixes on review: per-element `pointerleave` clears hover (enter
  alone left the halo/card stuck when moving onto empty canvas); stale
  cytoscape comments in graph-view refreshed.
- Known, deliberate divergence: NodeGraph gates relayout on the element
  node+edge ID set, not `membershipKey`'s (id, epoch) — an epoch-only bump
  (same ids) no longer forces a relayout. Immaterial for SVG: identical ids
  produce an identical layout, and there is no element re-creation concept
  to invalidate. `membershipKey` remains exported for topology-level users.
- RIG/EYEBALL (local session, stage-f "Graph rework" items): trackpad pan
  feel + pinch-zoom-at-pointer on macOS, marching-dash legibility, hover
  card modes, fullscreen refit, live-drag arrow smoothness on a dense graph.
