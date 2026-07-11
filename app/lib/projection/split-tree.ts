// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Projection split-view — recursive split-tree model + pure reducer (docs/
// proposals/projection-split-view.md §"Layout model", deliverable 2).
//
// The layout of a projection window is a recursive tree:
//   Leaf(pane) | Split{ dir: row|col, children, ratios }
// serialized into the window's URL (`?win`/state-in-URL precedent) so reload +
// manifest restore replay the exact layout. Every operation here is PURE and
// returns a NEW tree (structural sharing not required at this scale) so the
// reducer is fully unit-testable; the Vue shell stays a thin renderer over it.
//
// Invariants held on every returned tree:
//   - a `split` always has >= 2 children (a 1-child split collapses to its
//     child; a 0-child split collapses to null);
//   - `ratios.length === children.length` and `sum(ratios) === 1` (normalized);
//   - a `split`'s children are never directly-nested same-`dir` splits — they
//     are flattened, so a row-of-rows reads as one row (VSCode behavior).
//
// Renderer- and main-safe, Vue-free (pure data + math). Addresses splits by a
// numeric PATH (indices from the root) for divider resize; addresses panes by
// id for insert/remove/swap/find (a pane id is stable across a reload).

import { freshPaneId, type Pane } from "./descriptor.js";

export type SplitDir = "row" | "col";

export type LeafNode = { type: "leaf"; pane: Pane };
export type SplitNode = {
  type: "split";
  dir: SplitDir;
  children: SplitTree[];
  ratios: number[];
};
export type SplitTree = LeafNode | SplitNode;

/** Where a dropped pane lands relative to a target leaf. Edges SPLIT (the
 *  target's slot halves along the edge's axis); center MOVES/SWAPS. */
export type DropZone = "left" | "right" | "top" | "bottom" | "center";

/** Default minimum pane fraction of a split axis a divider drag may clamp to —
 *  a floor so a pane can't be dragged to zero width/height. The Vue layer may
 *  pass a px-derived value; this is the pure fallback. */
export const MIN_RATIO = 0.08;

export function leaf(pane: Pane): LeafNode {
  return { type: "leaf", pane };
}

/** Even ratios for `n` children. */
function evenRatios(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

/** Normalize a ratio vector to sum 1 (guards against drift/NaN/zeros). */
export function normalizeRatios(ratios: number[]): number[] {
  const clean = ratios.map((r) => (Number.isFinite(r) && r > 0 ? r : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  if (sum <= 0) return evenRatios(ratios.length);
  return clean.map((r) => r / sum);
}

/** Build a split, flattening any same-`dir` child into it and normalizing the
 *  ratios. Collapses to the single child when only one remains. */
function makeSplit(dir: SplitDir, children: SplitTree[], ratios?: number[]): SplitTree {
  // Flatten nested same-direction splits (their ratios scale into the parent).
  const flatChildren: SplitTree[] = [];
  const flatRatios: number[] = [];
  const r = ratios && ratios.length === children.length ? ratios : evenRatios(children.length);
  children.forEach((child, i) => {
    if (child.type === "split" && child.dir === dir) {
      child.children.forEach((gc, j) => {
        flatChildren.push(gc);
        flatRatios.push(r[i]! * child.ratios[j]!);
      });
    } else {
      flatChildren.push(child);
      flatRatios.push(r[i]!);
    }
  });
  if (flatChildren.length === 1) return flatChildren[0]!;
  return { type: "split", dir, children: flatChildren, ratios: normalizeRatios(flatRatios) };
}

/** Every pane in the tree, left-to-right / top-to-bottom (render order). */
export function panes(tree: SplitTree | null): Pane[] {
  if (!tree) return [];
  if (tree.type === "leaf") return [tree.pane];
  return tree.children.flatMap(panes);
}

export function findPane(tree: SplitTree | null, paneId: string): Pane | null {
  return panes(tree).find((p) => p.id === paneId) ?? null;
}

export function hasPane(tree: SplitTree | null, paneId: string): boolean {
  return findPane(tree, paneId) !== null;
}

export function paneCount(tree: SplitTree | null): number {
  return panes(tree).length;
}

/** Direction an edge splits along + whether the new pane goes BEFORE the target. */
function edgeGeometry(zone: Exclude<DropZone, "center">): { dir: SplitDir; before: boolean } {
  switch (zone) {
    case "left":
      return { dir: "row", before: true };
    case "right":
      return { dir: "row", before: false };
    case "top":
      return { dir: "col", before: true };
    case "bottom":
      return { dir: "col", before: false };
  }
}

/**
 * Insert `pane` next to the leaf `targetId` per `zone`:
 *   - an EDGE zone splits the target's slot in two along the edge's axis (the
 *     two panes share the target's former space 50/50);
 *   - CENTER replaces the target IN PLACE with the new pane (a move/swap when
 *     the caller has already removed the dragged pane elsewhere; see
 *     `movePane`). Returns the tree unchanged if the target isn't found.
 */
export function insertPane(
  tree: SplitTree,
  targetId: string,
  pane: Pane,
  zone: DropZone,
): SplitTree {
  const rewrite = (node: SplitTree): SplitTree => {
    if (node.type === "leaf") {
      if (node.pane.id !== targetId) return node;
      if (zone === "center") return leaf(pane);
      const { dir, before } = edgeGeometry(zone);
      const children = before ? [leaf(pane), node] : [node, leaf(pane)];
      return makeSplit(dir, children);
    }
    // Re-build through `makeSplit` so a freshly-created same-direction child
    // (e.g. splitting a leaf that sits inside a parallel split) flattens into
    // this node and keeps the "no directly-nested same-dir split" invariant —
    // its slot's ratio scales across the two new panes.
    return makeSplit(node.dir, node.children.map(rewrite), node.ratios);
  };
  return rewrite(tree);
}

/**
 * Remove the pane `paneId`, collapsing any split left with a single child and
 * re-normalizing sibling ratios. Returns null when the tree becomes empty (the
 * last pane was removed) — the caller (an empty projection window) closes.
 */
export function removePane(tree: SplitTree, paneId: string): SplitTree | null {
  const strip = (node: SplitTree): SplitTree | null => {
    if (node.type === "leaf") return node.pane.id === paneId ? null : node;
    const kept: SplitTree[] = [];
    const keptRatios: number[] = [];
    node.children.forEach((child, i) => {
      const next = strip(child);
      if (next) {
        kept.push(next);
        keptRatios.push(node.ratios[i]!);
      }
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!;
    return { type: "split", dir: node.dir, children: kept, ratios: normalizeRatios(keptRatios) };
  };
  return strip(tree);
}

/** Swap the panes held by two leaves (center-drop within a window = swap). */
export function swapPanes(tree: SplitTree, a: string, b: string): SplitTree {
  if (a === b) return tree;
  const pa = findPane(tree, a);
  const pb = findPane(tree, b);
  if (!pa || !pb) return tree;
  const rewrite = (node: SplitTree): SplitTree => {
    if (node.type === "leaf") {
      if (node.pane.id === a) return leaf(pb);
      if (node.pane.id === b) return leaf(pa);
      return node;
    }
    return { type: "split", dir: node.dir, children: node.children.map(rewrite), ratios: node.ratios };
  };
  return rewrite(tree);
}

/**
 * Move an EXISTING pane `paneId` to a new position relative to `targetId`
 * (within-window drag). Edge zones re-dock it beside the target; center swaps
 * the two panes. Remove-then-insert for edges (so the source slot collapses);
 * a no-op when target === source or either is missing.
 */
export function movePane(
  tree: SplitTree,
  paneId: string,
  targetId: string,
  zone: DropZone,
): SplitTree {
  if (paneId === targetId) return tree;
  const moving = findPane(tree, paneId);
  if (!moving || !hasPane(tree, targetId)) return tree;
  if (zone === "center") return swapPanes(tree, paneId, targetId);
  const without = removePane(tree, paneId);
  if (!without) return tree; // moving was the only pane — nothing to re-dock
  // The target survives removal (it isn't the moved pane), so re-insert beside it.
  return insertPane(without, targetId, moving, zone);
}

/**
 * Resize the divider at `dividerIndex` inside the split addressed by `path`
 * (root = []), shifting `delta` (fraction of that split's axis) from the child
 * after the divider to the one before it. Both neighbors clamp to `minRatio`;
 * the rest of the split's ratios are untouched. Out-of-range path/index → no-op.
 */
export function resizeDivider(
  tree: SplitTree,
  path: number[],
  dividerIndex: number,
  delta: number,
  minRatio: number = MIN_RATIO,
): SplitTree {
  const rewrite = (node: SplitTree, depth: number): SplitTree => {
    if (depth === path.length) {
      if (node.type !== "split") return node;
      const i = dividerIndex;
      if (i < 0 || i + 1 >= node.children.length) return node;
      const ratios = node.ratios.slice();
      const pair = ratios[i]! + ratios[i + 1]!;
      const lo = minRatio;
      const hi = pair - minRatio;
      if (hi <= lo) return node; // no room to move within the clamp
      let next = ratios[i]! + delta;
      next = Math.min(Math.max(next, lo), hi);
      ratios[i] = next;
      ratios[i + 1] = pair - next;
      return { type: "split", dir: node.dir, children: node.children, ratios };
    }
    if (node.type !== "split") return node;
    const idx = path[depth]!;
    if (idx < 0 || idx >= node.children.length) return node;
    const children = node.children.slice();
    children[idx] = rewrite(children[idx]!, depth + 1);
    return { type: "split", dir: node.dir, children, ratios: node.ratios };
  };
  return rewrite(tree, 0);
}

// ---- Serialization (round-trips through the window URL) --------------------

/** Layout codec version (independent of the pane codec — the tree shape can
 *  evolve without the pane wire shape changing, and vice-versa). */
export const TREE_CODEC_VERSION = 1 as const;

import { parsePaneObject } from "./descriptor.js";

/** Compact wire form of a tree (leaves carry the pane wire shape). */
function treeToWire(tree: SplitTree): unknown {
  if (tree.type === "leaf") return { t: "l", p: tree.pane };
  return {
    t: "s",
    d: tree.dir,
    c: tree.children.map(treeToWire),
    r: tree.ratios,
  };
}

function wireToTree(v: unknown): SplitTree | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.t === "l") {
    const pane = parsePaneObject(o.p);
    return pane ? leaf(pane) : null;
  }
  if (o.t === "s") {
    const dir: SplitDir = o.d === "col" ? "col" : "row";
    const rawChildren = Array.isArray(o.c) ? o.c : [];
    const children = rawChildren.map(wireToTree).filter((c): c is SplitTree => c !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    const ratios = Array.isArray(o.r) && o.r.length === children.length
      ? (o.r as number[])
      : evenRatios(children.length);
    return makeSplit(dir, children, ratios);
  }
  return null;
}

/** Serialize a tree to a URL-safe JSON string (the window's `layout` param). */
export function serializeTree(tree: SplitTree): string {
  return JSON.stringify({ v: TREE_CODEC_VERSION, tree: treeToWire(tree) });
}

/** Parse a `serializeTree` string, or null on malformed / wrong-version /
 *  empty input (the caller falls back to the legacy single-pane params). */
export function parseTree(s: string | null | undefined): SplitTree | null {
  if (!s) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const o = doc as Record<string, unknown>;
  if (o.v !== TREE_CODEC_VERSION) return null;
  return wireToTree(o.tree);
}

/** Build a fresh single-leaf tree for a pane (initial open). */
export function singleLeaf(pane: Pane): SplitTree {
  return leaf({ ...pane, id: pane.id || freshPaneId() });
}
