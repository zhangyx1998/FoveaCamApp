// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Profiler node-graph AUTO-LAYOUT — a hand-rolled Sugiyama-lite layered
// left-to-right pass that replaces cytoscape-dagre. Pure, deterministic,
// Vue/DOM-free, unit-tested. Our graphs are sparse LR pipeline DAGs (10–50
// nodes) with at most one feedback cycle, so three passes cover them:
//   1. RANK   — longest-path over the DAG; DFS back-edges are tolerated (they
//               still render, they just don't constrain ranks — cycles never
//               hang or crash). Sources at rank 0.
//   2. ORDER  — barycenter sweeps (down then up, deterministic, id tie-breaks)
//               to reduce within-rank edge crossings.
//   3. COORDS — x from cumulative rank widths + rankSep; y stacks each rank
//               with nodeSep, then a median-alignment pass pulls single-parent
//               chains straight. Disconnected components stack vertically.
// Positions are node CENTERS (model px); bbox covers node extents + padding.
// spec: docs/spec/profiler-graph.md#layout

import type { Box } from "./graph-viewport";

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}
export interface LayoutEdge {
  from: string;
  to: string;
}
export interface LayoutOptions {
  rankSep?: number;
  nodeSep?: number;
  padding?: number;
}
export interface LayoutResult {
  /** node CENTERS, model px */
  positions: Map<string, { x: number; y: number }>;
  /** tight bbox over node extents + padding */
  bbox: Box;
}

// Default rank/node separations for the layered layout.
const DEFAULT_RANK_SEP = 72;
const DEFAULT_NODE_SEP = 30;
const DEFAULT_PADDING = 12;
/** Vertical gap between disconnected components when stacked. */
const COMPONENT_SEP = 48;
/** Barycenter down+up sweep repetitions. */
const ORDER_PASSES = 4;
/** Median-alignment repetitions (down+up). */
const ALIGN_PASSES = 2;

type Pt = { x: number; y: number };

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, v) => a + v, 0) / xs.length;

/** One connected component's layered layout, in LOCAL coordinates whose node
 *  extents start at (0,0). Returns node centers + the content size. */
interface ComponentLayout {
  centers: Map<string, Pt>;
  size: { w: number; h: number };
}

/**
 * Sugiyama-lite for a single weakly-connected component.
 *
 * @param ids    component node ids (deterministic caller order; we re-sort by id
 *               wherever ties must break deterministically)
 * @param dims   id → {width,height}
 * @param edges  UNIQUE directed (from,to) pairs, both endpoints in `ids`
 */
function layoutComponent(
  ids: string[],
  dims: Map<string, { width: number; height: number }>,
  edges: Array<{ from: string; to: string }>,
  rankSep: number,
  nodeSep: number,
): ComponentLayout {
  const sorted = [...ids].sort();

  // --- back-edge detection (DFS; edge into a gray/on-stack node = back-edge) --
  const adj = new Map<string, string[]>();
  for (const id of sorted) adj.set(id, []);
  for (const e of edges) adj.get(e.from)!.push(e.to);
  for (const id of sorted) adj.get(id)!.sort();

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(sorted.map((id) => [id, WHITE]));
  const backEdges = new Set<string>(); // "from\0to"
  const edgeKey = (f: string, t: string): string => `${f}\0${t}`;
  // Iterative DFS to stay safe on deep chains.
  for (const root of sorted) {
    if (color.get(root) !== WHITE) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    color.set(root, GRAY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const nbrs = adj.get(top.id)!;
      if (top.i < nbrs.length) {
        const nb = nbrs[top.i++]!;
        const c = color.get(nb);
        if (nb === top.id || c === GRAY) {
          backEdges.add(edgeKey(top.id, nb)); // self-loop or back-edge
        } else if (c === WHITE) {
          color.set(nb, GRAY);
          stack.push({ id: nb, i: 0 });
        }
        // BLACK (cross/forward) edges are fine for ranking.
      } else {
        color.set(top.id, BLACK);
        stack.pop();
      }
    }
  }

  // Forward DAG = unique pairs minus back-edges.
  const parents = new Map<string, string[]>(sorted.map((id) => [id, []]));
  const children = new Map<string, string[]>(sorted.map((id) => [id, []]));
  for (const e of edges) {
    if (backEdges.has(edgeKey(e.from, e.to))) continue;
    parents.get(e.to)!.push(e.from);
    children.get(e.from)!.push(e.to);
  }

  // --- RANK: longest path over the forward DAG (memoized; DAG ⇒ no recursion
  // hazard, but we guard with an on-stack set anyway to be defensive). ---------
  const rank = new Map<string, number>();
  const inProgress = new Set<string>();
  const rankOf = (id: string): number => {
    const cached = rank.get(id);
    if (cached !== undefined) return cached;
    if (inProgress.has(id)) return 0; // defensive: should not happen on the DAG
    inProgress.add(id);
    const ps = parents.get(id)!;
    const r = ps.length === 0 ? 0 : Math.max(...ps.map((p) => rankOf(p) + 1));
    inProgress.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const id of sorted) rankOf(id);

  // --- ORDER: group into layers, barycenter sweeps to cut crossings ----------
  const maxRank = Math.max(0, ...sorted.map((id) => rank.get(id)!));
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of sorted) layers[rank.get(id)!]!.push(id);
  // Initial within-layer order is id-sorted (sorted[] preserves that).

  const indexIn = (layer: string[]): Map<string, number> =>
    new Map(layer.map((id, i) => [id, i]));

  const bary = (id: string, ref: Map<string, number>, adjm: Map<string, string[]>): number => {
    const nbrs = adjm.get(id)!.filter((n) => ref.has(n));
    return nbrs.length === 0 ? Number.NaN : mean(nbrs.map((n) => ref.get(n)!));
  };

  for (let pass = 0; pass < ORDER_PASSES; pass++) {
    // down sweep — order each layer by the barycenter of its PARENTS
    for (let r = 1; r <= maxRank; r++) {
      const ref = indexIn(layers[r - 1]!);
      const keep = indexIn(layers[r]!);
      layers[r]!.sort((a, b) => {
        const ba = bary(a, ref, parents);
        const bb = bary(b, ref, parents);
        const ka = Number.isNaN(ba) ? keep.get(a)! : ba;
        const kb = Number.isNaN(bb) ? keep.get(b)! : bb;
        return ka - kb || (a < b ? -1 : a > b ? 1 : 0);
      });
    }
    // up sweep — order each layer by the barycenter of its CHILDREN
    for (let r = maxRank - 1; r >= 0; r--) {
      const ref = indexIn(layers[r + 1]!);
      const keep = indexIn(layers[r]!);
      layers[r]!.sort((a, b) => {
        const ba = bary(a, ref, children);
        const bb = bary(b, ref, children);
        const ka = Number.isNaN(ba) ? keep.get(a)! : ba;
        const kb = Number.isNaN(bb) ? keep.get(b)! : bb;
        return ka - kb || (a < b ? -1 : a > b ? 1 : 0);
      });
    }
  }

  // --- COORDS: x from cumulative rank widths, y stacked + median-aligned ------
  const centers = new Map<string, Pt>();
  const rankWidth = layers.map((layer) =>
    layer.length === 0 ? 0 : Math.max(...layer.map((id) => dims.get(id)!.width)),
  );
  const rankCenterX: number[] = [];
  {
    let cursor = 0;
    for (let r = 0; r <= maxRank; r++) {
      rankCenterX[r] = cursor + rankWidth[r]! / 2;
      cursor += rankWidth[r]! + rankSep;
    }
  }

  // initial sequential y within each layer
  const cy = new Map<string, number>();
  for (let r = 0; r <= maxRank; r++) {
    let top = 0;
    for (const id of layers[r]!) {
      const h = dims.get(id)!.height;
      cy.set(id, top + h / 2);
      top += h + nodeSep;
    }
  }

  // Median-alignment: pull each node toward the median of its neighbors while
  // preserving within-layer order and the minimum gap. Forward-clamp then
  // recenter to the neighbor mean so the pass doesn't drift the whole layer.
  const resolve = (layer: string[], target: Map<string, number>): void => {
    if (layer.length === 0) return;
    const ys: number[] = [];
    for (let i = 0; i < layer.length; i++) {
      const id = layer[i]!;
      const h = dims.get(id)!.height;
      const want = target.get(id) ?? cy.get(id)!;
      if (i === 0) {
        ys[i] = want;
      } else {
        const prev = layer[i - 1]!;
        const minGap = dims.get(prev)!.height / 2 + nodeSep + h / 2;
        ys[i] = Math.max(want, ys[i - 1]! + minGap);
      }
    }
    // recenter to preserve the layer's mean target (shift preserves gaps)
    const wanted = layer.map((id) => target.get(id) ?? cy.get(id)!);
    const shift = mean(wanted) - mean(ys);
    for (let i = 0; i < layer.length; i++) cy.set(layer[i]!, ys[i]! + shift);
  };

  for (let pass = 0; pass < ALIGN_PASSES; pass++) {
    for (let r = 1; r <= maxRank; r++) {
      const target = new Map<string, number>();
      for (const id of layers[r]!) {
        const ps = parents.get(id)!;
        if (ps.length > 0) target.set(id, median(ps.map((p) => cy.get(p)!)));
      }
      resolve(layers[r]!, target);
    }
    for (let r = maxRank - 1; r >= 0; r--) {
      const target = new Map<string, number>();
      for (const id of layers[r]!) {
        const cs = children.get(id)!;
        if (cs.length > 0) target.set(id, median(cs.map((c) => cy.get(c)!)));
      }
      resolve(layers[r]!, target);
    }
  }

  for (const id of sorted) {
    centers.set(id, { x: rankCenterX[rank.get(id)!]!, y: cy.get(id)! });
  }

  // Normalize so node extents start at (0,0); report the content size.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of sorted) {
    const p = centers.get(id)!;
    const d = dims.get(id)!;
    minX = Math.min(minX, p.x - d.width / 2);
    minY = Math.min(minY, p.y - d.height / 2);
    maxX = Math.max(maxX, p.x + d.width / 2);
    maxY = Math.max(maxY, p.y + d.height / 2);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 0;
  }
  for (const id of sorted) {
    const p = centers.get(id)!;
    centers.set(id, { x: p.x - minX, y: p.y - minY });
  }
  return { centers, size: { w: maxX - minX, h: maxY - minY } };
}

/** Weakly-connected components (edges treated as undirected, back-edges
 *  included for connectivity). Deterministic: each component's id list is
 *  sorted, and components are ordered by their smallest id. */
function components(
  ids: string[],
  edges: Array<{ from: string; to: string }>,
): string[][] {
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    // path-compress
    let c = a;
    while (parent.get(c)! !== r) {
      const nxt = parent.get(c)!;
      parent.set(c, r);
      c = nxt;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) union(e.from, e.to);
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    const g = groups.get(r);
    if (g) g.push(id);
    else groups.set(r, [id]);
  }
  const out = [...groups.values()].map((g) => [...g].sort());
  out.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return out;
}

/**
 * Layer a sparse LR DAG. Nodes referenced by edges but absent from `nodes` are
 * ignored (defensive). Duplicate ids: last wins. Cycles are tolerated (DFS
 * back-edges don't constrain ranks and never hang). Positions are node centers.
 */
export function layoutDag(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions = {},
): LayoutResult {
  const rankSep = opts.rankSep ?? DEFAULT_RANK_SEP;
  const nodeSep = opts.nodeSep ?? DEFAULT_NODE_SEP;
  const padding = opts.padding ?? DEFAULT_PADDING;

  // Dedupe nodes: last wins. Insertion order = first-seen (Map semantics).
  const dims = new Map<string, { width: number; height: number }>();
  for (const n of nodes) dims.set(n.id, { width: n.width, height: n.height });
  const allIds = [...dims.keys()];

  // Keep only edges whose BOTH endpoints exist; dedupe directed pairs.
  const seen = new Set<string>();
  const cleanEdges: Array<{ from: string; to: string }> = [];
  for (const e of edges) {
    if (!dims.has(e.from) || !dims.has(e.to)) continue;
    const key = `${e.from}\0${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleanEdges.push({ from: e.from, to: e.to });
  }

  const positions = new Map<string, Pt>();
  if (allIds.length === 0) {
    return { positions, bbox: { x: 0, y: 0, w: 0, h: 0 } };
  }

  const comps = components(allIds, cleanEdges);
  const idComp = new Map<string, number>();
  comps.forEach((g, i) => g.forEach((id) => idComp.set(id, i)));

  let offsetY = 0;
  let maxW = 0;
  for (const comp of comps) {
    const compEdges = cleanEdges.filter(
      (e) => idComp.get(e.from) === idComp.get(comp[0]!),
    );
    const { centers, size } = layoutComponent(comp, dims, compEdges, rankSep, nodeSep);
    for (const [id, p] of centers) {
      positions.set(id, { x: p.x + padding, y: p.y + offsetY + padding });
    }
    maxW = Math.max(maxW, size.w);
    offsetY += size.h + COMPONENT_SEP;
  }
  const totalH = offsetY - COMPONENT_SEP; // drop the trailing separator

  return {
    positions,
    bbox: { x: 0, y: 0, w: maxW + 2 * padding, h: totalH + 2 * padding },
  };
}
