// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Projection split-view — cross-window drag intent + drop-zone geometry: the PURE
// decision layer the Vue drag handlers call (the effectAllowed/dropEffect move/copy
// matrix + the VSCode-style drop-zone geometry). Tree mutation lives in split-tree.ts;
// window-identity branching lives in the component — this file stays pure, table-tested.
// spec: docs/spec/projection.md#dnd

import type { DropZone } from "./split-tree.js";

/** Custom drag MIME — the descriptor rides `application/x-fovea-pane+json`.
 *  A private subtype so a foreign drag (a file, a text selection) never looks
 *  like a pane, and a pane drag never leaks into another app. */
export const PANE_MIME = "application/x-fovea-pane+json";

/** Where a drag started — an app window's pane layout is fixed, so its drags
 *  advertise copy-only. */
export type DragOrigin = "app" | "projection";

/** The resolved semantic of a drop. `move` re-docks the pane (source removes it
 *  on a successful `move` dragend); `copy` duplicates it at the destination. */
export type DragIntent = "move" | "copy";

/** Modifier state sampled during the drag (Alt/Option ⇒ duplicate). */
export type DragModifiers = { alt: boolean };

/**
 * Resolve the drop intent from the ORIGIN and the live modifiers:
 *   - app origin      → always `copy` (copy-only);
 *   - projection + Alt → `copy` (explicit duplicate);
 *   - projection      → `move` (the default).
 */
export function resolveIntent(origin: DragOrigin, mods: DragModifiers): DragIntent {
  if (origin === "app") return "copy";
  return mods.alt ? "copy" : "move";
}

/** `dataTransfer.effectAllowed` the SOURCE advertises for its origin: an app
 *  window offers copy only; a projection window offers both (the modifier then
 *  picks per-drop via `dropEffect`). */
export function effectAllowedFor(origin: DragOrigin): "copy" | "copyMove" {
  return origin === "app" ? "copy" : "copyMove";
}

/** `dataTransfer.dropEffect` the DESTINATION sets while dragging over a valid
 *  target — mirrors the resolved intent so the OS cursor reads move vs copy,
 *  and the source's dragend can check `dropEffect === "move"` to remove. */
export function dropEffectFor(origin: DragOrigin, mods: DragModifiers): DragIntent {
  return resolveIntent(origin, mods);
}

/**
 * Fraction of a pane's half-extent, measured from each edge, that reads as an
 * EDGE drop (the outer quadrant band); the inner region is CENTER. 0.5 would
 * make center vanish; the VSCode-like feel keeps a comfortable center target.
 */
export const EDGE_FRACTION = 0.28;

/**
 * Classify a pointer position inside a pane rect (normalized `nx,ny` ∈ [0,1])
 * into a drop zone. The pane is divided into four edge triangles + a center
 * rectangle: the nearest edge wins when the pointer is within `edgeFraction` of
 * it (by the smaller of the two axis distances), otherwise center. Ties broken
 * toward the horizontal edges (left/right) — matching VSCode's bias.
 */
export function dropZoneAt(
  nx: number,
  ny: number,
  edgeFraction: number = EDGE_FRACTION,
): DropZone {
  const x = clamp01(nx);
  const y = clamp01(ny);
  const distLeft = x;
  const distRight = 1 - x;
  const distTop = y;
  const distBottom = 1 - y;
  const nearest = Math.min(distLeft, distRight, distTop, distBottom);
  if (nearest >= edgeFraction) return "center";
  // Pick the closest edge; horizontal edges win ties (VSCode bias).
  if (distLeft === nearest) return "left";
  if (distRight === nearest) return "right";
  if (distTop === nearest) return "top";
  return "bottom";
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(Math.max(v, 0), 1);
}

/**
 * Whether a drop should be REFUSED as a no-op: a within-window MOVE onto the
 * pane's own center (dropping a pane onto itself changes nothing). Edge drops
 * onto own pane are also no-ops for a move (re-docking beside itself). Pure so
 * the component's over/drop guards share one rule.
 */
export function isNoopDrop(args: {
  intent: DragIntent;
  sameWindow: boolean;
  draggedPaneId: string;
  targetPaneId: string;
}): boolean {
  const { intent, sameWindow, draggedPaneId, targetPaneId } = args;
  // Only a within-window MOVE of a pane onto ITSELF is a guaranteed no-op:
  // center = swap-with-self, any edge = remove-then-reinsert to the same layout.
  // A copy onto self is a legitimate duplicate, so it is NOT a no-op.
  return intent === "move" && sameWindow && draggedPaneId === targetPaneId;
}
