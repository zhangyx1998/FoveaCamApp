// Profiler node-graph AUTO-LAYOUT (graph-layout.ts) — the hand-rolled
// Sugiyama-lite layered LR pass that replaces cytoscape-dagre. Pure +
// deterministic: longest-path ranking with DFS back-edge tolerance, barycenter
// crossing reduction, coordinate assignment, disconnected-component stacking.

import { describe, expect, it } from "vitest";
import {
  layoutDag,
  type LayoutEdge,
  type LayoutNode,
} from "@src/profiler/graph-layout";

const N = (id: string, width = 100, height = 40): LayoutNode => ({ id, width, height });
const E = (from: string, to: string): LayoutEdge => ({ from, to });

/** node extent box from a center + dims. */
const extent = (
  c: { x: number; y: number },
  n: LayoutNode,
): { l: number; r: number; t: number; b: number } => ({
  l: c.x - n.width / 2,
  r: c.x + n.width / 2,
  t: c.y - n.height / 2,
  b: c.y + n.height / 2,
});

describe("ranking — longest path, LR, with cycle tolerance", () => {
  it("ranks a linear chain left-to-right by increasing x", () => {
    const { positions } = layoutDag(
      [N("a"), N("b"), N("c")],
      [E("a", "b"), E("b", "c")],
    );
    const x = (id: string): number => positions.get(id)!.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
  });

  it("ranks by the LONGEST path (a diamond's tail sits past the long branch)", () => {
    // a → b → d and a → d : d must rank after b (longest path = 2), not after a.
    const { positions } = layoutDag(
      [N("a"), N("b"), N("d")],
      [E("a", "b"), E("b", "d"), E("a", "d")],
    );
    const x = (id: string): number => positions.get(id)!.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("d"));
  });

  it("tolerates a feedback cycle: never hangs, back-edge excluded from ranks", () => {
    // a → b → c → a (PID-style loop). Ranking uses only the forward edges.
    const res = layoutDag(
      [N("a"), N("b"), N("c")],
      [E("a", "b"), E("b", "c"), E("c", "a")],
    );
    const x = (id: string): number => res.positions.get(id)!.x;
    expect(res.positions.size).toBe(3);
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
  });

  it("tolerates a self-loop without hanging", () => {
    const res = layoutDag([N("a"), N("b")], [E("a", "a"), E("a", "b")]);
    expect(res.positions.size).toBe(2);
    expect(res.positions.get("a")!.x).toBeLessThan(res.positions.get("b")!.x);
  });
});

describe("determinism", () => {
  it("is invariant to node + edge input order", () => {
    const nodes = [N("a"), N("b"), N("c"), N("d"), N("e")];
    const edges = [E("a", "b"), E("a", "c"), E("b", "d"), E("c", "d"), E("d", "e")];
    const one = layoutDag(nodes, edges);
    const two = layoutDag(
      [...nodes].reverse(),
      [...edges].reverse(),
    );
    expect([...two.positions.entries()].sort()).toEqual(
      [...one.positions.entries()].sort(),
    );
    expect(two.bbox).toEqual(one.bbox);
  });

  it("is byte-stable across repeated runs", () => {
    const nodes = [N("x"), N("y"), N("z")];
    const edges = [E("x", "y"), E("x", "z")];
    expect(layoutDag(nodes, edges)).toEqual(layoutDag(nodes, edges));
  });
});

describe("ordering — barycenter reduces crossings on a known fixture", () => {
  // Two ranks with a deliberate crossing under the id-sorted initial order:
  //   a1 → b2, a2 → b1. Id order puts b1 above b2, which crosses both edges;
  //   the barycenter sweep must flip b2 above b1 to remove the crossing.
  const edges = [E("a1", "b2"), E("a2", "b1")];
  const { positions } = layoutDag(
    [N("a1"), N("a2"), N("b1"), N("b2")],
    edges,
  );

  const crossings = (yOf: (id: string) => number): number => {
    let c = 0;
    for (let i = 0; i < edges.length; i++)
      for (let j = i + 1; j < edges.length; j++) {
        const s = Math.sign(yOf(edges[i]!.from) - yOf(edges[j]!.from));
        const t = Math.sign(yOf(edges[i]!.to) - yOf(edges[j]!.to));
        if (s * t < 0) c++;
      }
    return c;
  };

  it("the laid-out ordering has zero crossings", () => {
    expect(crossings((id) => positions.get(id)!.y)).toBe(0);
  });

  it("the naive id-sorted ordering would have one crossing", () => {
    const idOrderY: Record<string, number> = { a1: 0, a2: 1, b1: 0, b2: 1 };
    expect(crossings((id) => idOrderY[id]!)).toBe(1);
  });

  it("put b2 above b1 (the reorder that removed the crossing)", () => {
    expect(positions.get("b2")!.y).toBeLessThan(positions.get("b1")!.y);
  });
});

describe("disconnected components stack vertically", () => {
  it("keeps two components from overlapping in y", () => {
    // {a→b} and {c→d} share no edges → separate components.
    const nodes = [N("a"), N("b"), N("c"), N("d")];
    const { positions, bbox } = layoutDag(nodes, [E("a", "b"), E("c", "d")]);
    const box = (id: string) => extent(positions.get(id)!, N(id));
    const comp1Bottom = Math.max(box("a").b, box("b").b);
    const comp2Top = Math.min(box("c").t, box("d").t);
    // component {a,b} (smaller min id) sits entirely above component {c,d}
    expect(comp1Bottom).toBeLessThan(comp2Top);
    // and the bbox covers the whole stack
    expect(bbox.h).toBeGreaterThanOrEqual(Math.max(box("c").b, box("d").b));
  });
});

describe("bbox — centers, padding, tightness", () => {
  it("a single node: center offset by padding, bbox = extent + 2·padding", () => {
    const { positions, bbox } = layoutDag([N("a", 100, 40)], [], { padding: 12 });
    expect(positions.get("a")).toEqual({ x: 62, y: 32 }); // 12 + 50, 12 + 20
    expect(bbox).toEqual({ x: 0, y: 0, w: 124, h: 64 }); // 100+24, 40+24
  });

  it("empty graph → empty positions + zero bbox", () => {
    const { positions, bbox } = layoutDag([], []);
    expect(positions.size).toBe(0);
    expect(bbox).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("the bbox tightly covers every node extent + padding", () => {
    const pad = 12;
    const nodes = [N("a"), N("b"), N("c"), N("d")];
    const { positions, bbox } = layoutDag(
      nodes,
      [E("a", "b"), E("a", "c"), E("b", "d"), E("c", "d")],
      { padding: pad },
    );
    let minL = Infinity;
    let minT = Infinity;
    let maxR = -Infinity;
    let maxB = -Infinity;
    for (const n of nodes) {
      const b = extent(positions.get(n.id)!, n);
      minL = Math.min(minL, b.l);
      minT = Math.min(minT, b.t);
      maxR = Math.max(maxR, b.r);
      maxB = Math.max(maxB, b.b);
      // every node lies inside the bbox
      expect(b.l).toBeGreaterThanOrEqual(bbox.x - 1e-9);
      expect(b.t).toBeGreaterThanOrEqual(bbox.y - 1e-9);
      expect(b.r).toBeLessThanOrEqual(bbox.x + bbox.w + 1e-9);
      expect(b.b).toBeLessThanOrEqual(bbox.y + bbox.h + 1e-9);
    }
    // tight: the extreme extents sit exactly `pad` inside each edge
    expect(minL).toBeCloseTo(bbox.x + pad);
    expect(minT).toBeCloseTo(bbox.y + pad);
    expect(maxR).toBeCloseTo(bbox.x + bbox.w - pad);
    expect(maxB).toBeCloseTo(bbox.y + bbox.h - pad);
  });
});

describe("defensive input handling", () => {
  it("ignores edges referencing absent nodes", () => {
    const res = layoutDag([N("a")], [E("a", "ghost"), E("phantom", "a")]);
    expect(res.positions.size).toBe(1);
    expect(res.positions.has("a")).toBe(true);
  });

  it("duplicate ids: last wins for dimensions", () => {
    const { bbox } = layoutDag([N("a", 10, 10), N("a", 200, 50)], [], { padding: 0 });
    expect(bbox).toEqual({ x: 0, y: 0, w: 200, h: 50 });
  });

  it("single-parent chains straighten (median alignment pulls them level)", () => {
    // a → b → c: a lone chain should end up with all three at the same y.
    const { positions } = layoutDag([N("a"), N("b"), N("c")], [E("a", "b"), E("b", "c")]);
    expect(positions.get("b")!.y).toBeCloseTo(positions.get("a")!.y);
    expect(positions.get("c")!.y).toBeCloseTo(positions.get("a")!.y);
  });
});
