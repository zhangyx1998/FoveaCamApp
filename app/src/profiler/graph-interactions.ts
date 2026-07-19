// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE logic behind the node-graph interactions (ctrl-wheel zoom gating,
// dragged-position preservation, edge-path geometry) + the report rate. The
// graph fills its profiler tab (no separate resizable-height block).
// Vue/DOM/cytoscape-free, unit-tested.
// spec: docs/spec/profiler-graph.md#interactions

import { ZOOM_MIN, ZOOM_MAX } from "./graph-viewport";

// --- Wheel-event gating + zoom math ------------------------------------------

/** Zoom ONLY on ctrl+wheel. macOS trackpad pinch arrives as a wheel event
 *  with `ctrlKey: true` — same path, no special-casing. Plain scroll must
 *  fall through so the page scrolls. */
export function isZoomGesture(ev: { ctrlKey: boolean }): boolean {
  return ev.ctrlKey;
}

// Zoom bounds live in graph-viewport.ts (the viewport algebra owns them);
// re-exported here so `nextZoomLevel` and the existing public API agree.
export { ZOOM_MIN, ZOOM_MAX };
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

// --- Perpendicular-stem edge geometry ------------
//
// The graph is layered LR: every edge leaves the SOURCE's right face and enters
// the TARGET's left face. The stem must leave/enter PERPENDICULAR to that face
// — i.e. horizontally. In hand-rolled SVG that is simply a cubic whose two
// control points sit `off` px horizontally off each endpoint (`edgePath`).

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

/** SVG cubic-Bézier `d` for an edge from `s` to `t`, leaving the source's RIGHT
 *  face and entering the target's LEFT face HORIZONTALLY (control points sit
 *  `off = stemOffset(|t−s|)` px to the right of `s` and to the left of `t`).
 *  Degenerate coincident endpoints collapse to a straight `M s L t` (a no-op
 *  zero-length segment when truly identical) — the caller never divides by a
 *  zero-length stem. */
export function edgePath(s: NodePosition, t: NodePosition): string {
  const dist = Math.hypot(t.x - s.x, t.y - s.y);
  if (dist < 1e-6) return `M ${s.x} ${s.y} L ${t.x} ${t.y}`;
  const off = stemOffset(dist);
  return `M ${s.x} ${s.y} C ${s.x + off} ${s.y}, ${t.x - off} ${t.y}, ${t.x} ${t.y}`;
}
