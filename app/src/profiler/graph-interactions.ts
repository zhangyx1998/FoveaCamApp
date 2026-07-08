// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Profiler UI interaction helpers — the PURE logic behind GraphPanel's canvas
// interactions (vertical resize persistence, ctrl-wheel zoom gating,
// dragged-position preservation) and ProfilerWindow's configurable report
// rate. Vue-free, DOM-free, cytoscape-free by design so the decision logic is
// unit-testable (app/test/graph-interactions.test.ts); the components keep
// only the thin event wiring.

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
