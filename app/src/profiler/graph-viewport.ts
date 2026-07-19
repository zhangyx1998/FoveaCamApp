// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Profiler node-graph VIEWPORT algebra — pure, Vue/DOM-free, unit-tested.
// One coordinate convention: screen = model · zoom + pan (pan in screen px).
// Owns the zoom bounds (single source of truth; graph-interactions re-exports).
// Core operations:
//   clampPan — the model point at the container CENTER stays in the graph bbox;
//   viewportContent / resizeViewport — refit the visible content on resize;
//   zoomAt — zoom keeps the model point under the POINTER fixed.
// spec: docs/spec/profiler-graph.md#interactions

/** Axis-aligned box in model space (px). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Container pixel size. */
export interface Size {
  w: number;
  h: number;
}

/** The view transform: uniform `zoom` + a screen-space `pan` offset. */
export interface Viewport {
  zoom: number;
  pan: { x: number; y: number };
}

/** Zoom clamp — the canonical source of truth for the whole graph feature
 *  (graph-interactions.ts re-exports these so `nextZoomLevel` agrees). */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 10;

/** fitBox never magnifies a tiny graph past this — a 3-node pipeline blown up
 *  10× fills the tab with almost nothing; capping at 2× keeps it legible while
 *  still centered. (Never exceeds ZOOM_MAX either.) */
export const FIT_ZOOM_MAX = 2;

/** fitBox default inner padding (px, each side) — a little air around the
 *  contain-fit so nodes never kiss the tab edge. */
export const FIT_PADDING = 24;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const clampZoom = (z: number): number => clamp(z, ZOOM_MIN, ZOOM_MAX);

/** Box → the model point at its center. */
function centerOf(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Model → screen (px): `screen = model · zoom + pan`. */
export function modelToScreen(
  m: { x: number; y: number },
  vp: Viewport,
): { x: number; y: number } {
  return { x: m.x * vp.zoom + vp.pan.x, y: m.y * vp.zoom + vp.pan.y };
}

/** Screen (px) → model: the exact inverse of `modelToScreen`. */
export function screenToModel(
  s: { x: number; y: number },
  vp: Viewport,
): { x: number; y: number } {
  return { x: (s.x - vp.pan.x) / vp.zoom, y: (s.y - vp.pan.y) / vp.zoom };
}

/** Box intersection in model space; null when the boxes don't overlap (a
 *  zero-area touch counts as no overlap — `w`/`h` must be strictly positive). */
export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bot = Math.min(a.y + a.h, b.y + b.h);
  const w = r - x;
  const h = bot - y;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/** The model-space box currently visible in `container` under `vp`. */
export function viewportBox(vp: Viewport, container: Size): Box {
  const tl = screenToModel({ x: 0, y: 0 }, vp);
  return { x: tl.x, y: tl.y, w: container.w / vp.zoom, h: container.h / vp.zoom };
}

/** The model content actually on screen = intersection(visible box,
 *  graph bbox). Null when nothing of the graph is visible (empty intersection)
 *  — the caller falls back to the whole graph. */
export function viewportContent(
  vp: Viewport,
  container: Size,
  graph: Box,
): Box | null {
  return intersect(viewportBox(vp, container), graph);
}

/** Clamp `pan` so the model point at the container CENTER always lies
 *  inside the graph bbox. Solving `screenToModel(center).{x,y} ∈ graph` for pan
 *  gives a closed interval per axis; we clamp into it. A degenerate zero-size
 *  graph collapses the interval to a point → the center pins to that point. */
export function clampPan(vp: Viewport, container: Size, graph: Box): Viewport {
  // centerModel.x = (container.w/2 − pan.x) / zoom ∈ [graph.x, graph.x+graph.w]
  //   ⇒ pan.x ∈ [container.w/2 − (graph.x+graph.w)·zoom, container.w/2 − graph.x·zoom]
  const loX = container.w / 2 - (graph.x + graph.w) * vp.zoom;
  const hiX = container.w / 2 - graph.x * vp.zoom;
  const loY = container.h / 2 - (graph.y + graph.h) * vp.zoom;
  const hiY = container.h / 2 - graph.y * vp.zoom;
  return {
    zoom: vp.zoom,
    pan: { x: clamp(vp.pan.x, loX, hiX), y: clamp(vp.pan.y, loY, hiY) },
  };
}

/** Pan by a screen-px delta (scroll), then clamp. */
export function panBy(
  vp: Viewport,
  dx: number,
  dy: number,
  container: Size,
  graph: Box,
): Viewport {
  return clampPan(
    { zoom: vp.zoom, pan: { x: vp.pan.x + dx, y: vp.pan.y + dy } },
    container,
    graph,
  );
}

/** Zoom to `nextZoom` (clamped) keeping the model point under
 *  `pointer` (container-relative px) fixed on screen, then clampPan. */
export function zoomAt(
  vp: Viewport,
  nextZoom: number,
  pointer: { x: number; y: number },
  container: Size,
  graph: Box,
): Viewport {
  const z = clampZoom(nextZoom);
  const m = screenToModel(pointer, vp); // model point currently under the pointer
  // Solve modelToScreen(m, next) = pointer for the new pan: pan = pointer − m·z.
  const pan = { x: pointer.x - m.x * z, y: pointer.y - m.y * z };
  return clampPan({ zoom: z, pan }, container, graph);
}

/** Contain-fit `target` into `container` (inner padding `pad`) and center it.
 *  Zoom is the smaller of the two axis ratios, floored at ZOOM_MIN and capped
 *  at FIT_ZOOM_MAX so a tiny graph is not magnified absurdly. A degenerate
 *  zero-size target yields the cap zoom, centered. No pan clamp (callers that
 *  need it clamp after — e.g. resizeViewport). */
export function fitBox(
  target: Box,
  container: Size,
  pad: number = FIT_PADDING,
): Viewport {
  const availW = container.w - 2 * pad;
  const availH = container.h - 2 * pad;
  const ratioW = target.w > 0 ? availW / target.w : Infinity;
  const ratioH = target.h > 0 ? availH / target.h : Infinity;
  const zoom = clamp(Math.min(ratioW, ratioH), ZOOM_MIN, FIT_ZOOM_MAX);
  const c = centerOf(target);
  return {
    zoom,
    pan: { x: container.w / 2 - c.x * zoom, y: container.h / 2 - c.y * zoom },
  };
}

/** On container resize keep looking at the SAME model content.
 *  content = viewportContent(prev) — the whole graph when that is null/degenerate
 *  (e.g. the first reveal from a 0×0 box) — refit into `next`, then clampPan. */
export function resizeViewport(
  vp: Viewport,
  prev: Size,
  next: Size,
  graph: Box,
): Viewport {
  const content = viewportContent(vp, prev, graph) ?? graph;
  return clampPan(fitBox(content, next), next, graph);
}
