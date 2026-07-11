// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE logic behind GraphPanel's canvas interactions (resize persistence,
// ctrl-wheel zoom gating, dragged-position preservation) + the report rate.
// Vue/DOM/cytoscape-free, unit-tested.
// spec: docs/spec/profiler-graph.md#interactions

// --- Graph canvas height (vertical resize, persisted) -----------------------

export const GRAPH_HEIGHT_KEY = "profiler:graph-height";
export const DEFAULT_GRAPH_HEIGHT = 380;
export const MIN_GRAPH_HEIGHT = 200;

/** Clamp a candidate canvas height: at least MIN, integral, and safe against
 *  NaN/Infinity (falls back to the default). */
export function clampGraphHeight(h: number): number {
  if (!Number.isFinite(h)) return DEFAULT_GRAPH_HEIGHT;
  return Math.max(MIN_GRAPH_HEIGHT, Math.round(h));
}

/** Parse the persisted height (localStorage round-trip): absent/garbage →
 *  default; numeric strings are clamped like live input. */
export function parseGraphHeight(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_GRAPH_HEIGHT;
  const n = Number(raw);
  return Number.isFinite(n) ? clampGraphHeight(n) : DEFAULT_GRAPH_HEIGHT;
}

// --- Wheel-event gating + zoom math ------------------------------------------

/** Zoom ONLY on ctrl+wheel. macOS trackpad pinch arrives as a wheel event
 *  with `ctrlKey: true` — same path, no special-casing. Plain scroll must
 *  fall through so the page scrolls. */
export function isZoomGesture(ev: { ctrlKey: boolean }): boolean {
  return ev.ctrlKey;
}

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 10;
/** Exponential zoom feel: sensitivity per wheel deltaY unit. */
const ZOOM_RATE = 0.01;

/** Next zoom level for a wheel delta (deltaY < 0 = zoom in), clamped to
 *  [ZOOM_MIN, ZOOM_MAX]. Multiplicative so zoom speed is scale-invariant. */
export function nextZoomLevel(level: number, deltaY: number): number {
  const next = level * Math.exp(-deltaY * ZOOM_RATE);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
}

// --- Dragged-position preservation -------------------------------------------

export type NodePosition = { x: number; y: number };

/** Prune dragged positions for nodes that left the graph: the periodic
 *  topology refresh re-applies ONLY surviving user-dragged positions after a
 *  re-layout (auto-layout owns every node the user hasn't touched). Returns a
 *  new map — never mutates the input. */
export function reconcileDraggedPositions(
  dragged: ReadonlyMap<string, NodePosition>,
  liveIds: Iterable<string>,
): Map<string, NodePosition> {
  const live = new Set(liveIds);
  const out = new Map<string, NodePosition>();
  for (const [id, pos] of dragged) if (live.has(id)) out.set(id, pos);
  return out;
}

// --- Profiler report rate (perfSnapshot poll interval) ------------------------

export const REPORT_INTERVAL_KEY = "profiler:report-interval-ms";
export const DEFAULT_REPORT_INTERVAL_MS = 1000;

/** Offered report rates. The poll interval bounds how often edge stats
 *  (incl. max packet interval) are SAMPLED — meter capture windows are
 *  unaffected. */
export const REPORT_INTERVAL_OPTIONS = [
  { ms: 500, label: "0.5 s" },
  { ms: 1000, label: "1 s" },
  { ms: 2000, label: "2 s" },
  { ms: 5000, label: "5 s" },
] as const;

/** Parse the persisted report interval: anything that isn't exactly one of
 *  the offered options falls back to the default (1 s). */
export function parseReportInterval(raw: string | null): number {
  const n = Number(raw);
  return REPORT_INTERVAL_OPTIONS.some((o) => o.ms === n)
    ? n
    : DEFAULT_REPORT_INTERVAL_MS;
}

// --- Perpendicular-stem edge geometry (user 2026-07-10, ruling 1) ------------
//
// The graph is dagre LR: every edge attaches the SOURCE's right face and the
// TARGET's left face (pinned via `source-endpoint`/`target-endpoint`). The user
// ruling is that the stem must leave/enter PERPENDICULAR to that face — i.e.
// horizontally — instead of the old `unbundled-bezier`'s oblique tangents.
//
// With cytoscape's `edge-distances: endpoints`, an unbundled-bezier control
// point is `S + w·(T−S) + d·n`, where S/T are the manual attachment points and
// `n = (−dy, dx)/l` is cytoscape's endpoint normal (`recalcVectorNormInverse`,
// cytoscape 3.34 renderer). We want the two cubic control points on the face
// normals: C1 = S + off·(+1,0) (source right-face outward normal) and
// C2 = T + off·(−1,0) (target left-face outward normal). Decomposing each onto
// the {L, n} basis gives the (weight, distance) pair below — exact, so the
// tangents are horizontal regardless of how the nodes are dragged.

/** Stem length as a fraction of the attachment-point separation… */
export const STEM_FRACTION = 0.35;
/** …clamped so short edges still read as a curve and long ones don't balloon. */
export const STEM_MIN_PX = 22;
export const STEM_MAX_PX = 90;
/** Vertical spread (px) between same-direction parallel edges' attachment
 *  points, so their perpendicular stems stay parallel instead of overlapping. */
export const LANE_STEP_PX = 12;

/** Perpendicular stem offset for an attachment-point separation `length`. */
export function stemOffset(length: number): number {
  return Math.min(STEM_MAX_PX, Math.max(STEM_MIN_PX, length * STEM_FRACTION));
}

/** Signed vertical offset (px) for lane `lane` of `lanes` same-direction
 *  parallels — 0-centered so the fan is symmetric about the face midpoint. */
export function laneOffset(lane: number, lanes: number): number {
  return lanes > 1 ? (lane - (lanes - 1) / 2) * LANE_STEP_PX : 0;
}

/** cytoscape `unbundled-bezier` (edge-distances: endpoints) control points that
 *  make a cubic stem leave the source's RIGHT face and enter the target's LEFT
 *  face HORIZONTALLY (perpendicular to the LR attachment faces). `s`/`t` are the
 *  manual attachment points in model px. Returns the two-element weight +
 *  distance arrays, or null when the endpoints coincide (degenerate — the panel
 *  keeps cytoscape's straight fallback). */
export function perpendicularControlPoints(
  s: NodePosition,
  t: NodePosition,
): { weights: [number, number]; distances: [number, number] } | null {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-6) return null;
  const l = Math.sqrt(l2);
  const off = stemOffset(l);
  // C1 = s + off·(+1,0): w = off·dx/l², d = −off·dy/l (project onto {L, n}).
  // C2 = t + off·(−1,0): w = 1 − off·dx/l², d = +off·dy/l.
  return {
    weights: [(off * dx) / l2, 1 - (off * dx) / l2],
    distances: [(-off * dy) / l, (off * dy) / l],
  };
}
