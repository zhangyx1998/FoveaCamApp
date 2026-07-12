// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE hover-card placement math for the profiler node graph (ruling 8, DOM-free,
// unit-tested). Two behaviors behind the `profiler_hover_card` config entry:
//   - `follow`  — the card follows the cursor, quadrant-flipped so it never
//                 overflows the graph container (prefer below-right of cursor).
//   - `corner`  — the card snaps to a container corner (+ margin), choosing the
//                 corner whose rect covers the hovered element least (ties →
//                 farthest from cursor), so it never sits on top of what you hover.
// All coordinates are CONTAINER-RELATIVE px (top-left origin).
// spec: docs/spec/profiler-graph.md#hover

export type HoverCardMode = "follow" | "corner";

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Clamp `v` to [lo, hi]; degenerate (hi < lo, i.e. the card is larger than the
 *  container along this axis) pins to `lo` so a tiny container never yields NaN
 *  or a negative-width placement. */
function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * FOLLOW placement (ruling 8a): anchor the card's top-left near the cursor,
 * preferring the BELOW-RIGHT quadrant (`+offset, +offset`). Flip HORIZONTALLY to
 * the left of the cursor when the right edge would overflow the container, and
 * VERTICALLY above the cursor when the bottom edge would overflow — the classic
 * four-quadrant tooltip flip. A final clamp keeps the card fully inside even in
 * the degenerate tiny-container case (card larger than the container → pinned to
 * the top-left).
 */
export function followPlacement(
  cursor: Point,
  card: Size,
  container: Size,
  offset = 12,
): Point {
  // Horizontal: prefer to the right of the cursor; flip left on right-overflow.
  let x = cursor.x + offset;
  if (x + card.w > container.w) x = cursor.x - offset - card.w;
  // Vertical: prefer below the cursor; flip above on bottom-overflow.
  let y = cursor.y + offset;
  if (y + card.h > container.h) y = cursor.y - offset - card.h;
  return {
    x: clamp(x, 0, container.w - card.w),
    y: clamp(y, 0, container.h - card.h),
  };
}

/** Overlap area between two boxes (0 when disjoint). */
function overlapArea(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

/**
 * CORNER placement (ruling 8b): snap the card to one of the four container
 * corners (inset by `margin`). Among the four, pick the corner whose resulting
 * card rect overlaps the hovered `item` bbox the LEAST — so the card never sits
 * on top of what the user is inspecting. Ties (equal overlap — the common case
 * when the item is small and central) break toward the corner FARTHEST from the
 * cursor (card center → cursor distance), keeping the card out from under the
 * pointer. Corner coordinates are clamped so a container smaller than the card
 * degrades gracefully to the top-left instead of producing negative offsets.
 */
export function cornerPlacement(
  item: Box,
  cursor: Point,
  card: Size,
  container: Size,
  margin = 8,
): Point {
  const maxX = container.w - card.w - margin;
  const maxY = container.h - card.h - margin;
  const corners: Point[] = [
    { x: margin, y: margin }, // TL
    { x: maxX, y: margin }, // TR
    { x: margin, y: maxY }, // BL
    { x: maxX, y: maxY }, // BR
  ].map((c) => ({
    x: clamp(c.x, 0, container.w - card.w),
    y: clamp(c.y, 0, container.h - card.h),
  }));

  let best = corners[0]!;
  let bestOverlap = Infinity;
  let bestDist = -Infinity;
  for (const c of corners) {
    const rect: Box = { x: c.x, y: c.y, w: card.w, h: card.h };
    const overlap = overlapArea(rect, item);
    const cx = c.x + card.w / 2;
    const cy = c.y + card.h / 2;
    const dist = Math.hypot(cx - cursor.x, cy - cursor.y);
    // Least item overlap wins; ties break toward the corner farthest from cursor.
    if (overlap < bestOverlap - 1e-6 || (Math.abs(overlap - bestOverlap) <= 1e-6 && dist > bestDist)) {
      best = c;
      bestOverlap = overlap;
      bestDist = dist;
    }
  }
  return best;
}
