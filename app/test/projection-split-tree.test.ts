// Projection split-tree reducer: insert/remove/resize/move/swap + serialize
// round-trip, with the split invariants (>=2 children, normalized ratios,
// same-dir flattening).

import { describe, expect, it } from "vitest";
import type { Pane } from "@lib/projection/descriptor";
import {
  findPane,
  insertPane,
  leaf,
  movePane,
  normalizeRatios,
  paneCount,
  panes,
  parseTree,
  removePane,
  resizeDivider,
  serializeTree,
  singleLeaf,
  swapPanes,
  type SplitNode,
  type SplitTree,
} from "@lib/projection/split-tree";

let n = 0;
function pane(id?: string): Pane {
  const key = id ?? `g${++n}`;
  return { id: key, source: { kind: "pipe", id: `pipe:${key}` } };
}

const A = pane("A");
const B = pane("B");
const C = pane("C");
const D = pane("D");

describe("normalizeRatios", () => {
  it("normalizes to sum 1 and guards zeros/NaN", () => {
    expect(normalizeRatios([1, 1]).reduce((a, b) => a + b)).toBeCloseTo(1);
    expect(normalizeRatios([2, 0, 2])).toEqual([0.5, 0, 0.5]);
    expect(normalizeRatios([0, 0])).toEqual([0.5, 0.5]); // all-zero → even
    expect(normalizeRatios([NaN, 1])).toEqual([0, 1]);
  });
});

describe("insertPane", () => {
  it("splits a leaf along the edge axis (right → row, after)", () => {
    const t = insertPane(leaf(A), "A", B, "right") as SplitNode;
    expect(t.type).toBe("split");
    expect(t.dir).toBe("row");
    expect(panes(t).map((p) => p.id)).toEqual(["A", "B"]);
    expect(t.ratios).toEqual([0.5, 0.5]);
  });
  it("splits before the target on a left/top edge", () => {
    const t = insertPane(leaf(A), "A", B, "left") as SplitNode;
    expect(panes(t).map((p) => p.id)).toEqual(["B", "A"]);
    const v = insertPane(leaf(A), "A", B, "top") as SplitNode;
    expect(v.dir).toBe("col");
    expect(panes(v).map((p) => p.id)).toEqual(["B", "A"]);
  });
  it("center replaces the target pane in place", () => {
    const t = insertPane(leaf(A), "A", B, "center");
    expect(t).toEqual(leaf(B));
  });
  it("flattens a same-direction nested split", () => {
    // A|B, then insert C to the right of B → still ONE row of A,B,C.
    let t: SplitTree = insertPane(leaf(A), "A", B, "right");
    t = insertPane(t, "B", C, "right");
    expect(t.type).toBe("split");
    const s = t as SplitNode;
    expect(s.dir).toBe("row");
    expect(s.children.every((c) => c.type === "leaf")).toBe(true);
    expect(panes(t).map((p) => p.id)).toEqual(["A", "B", "C"]);
  });
  it("nests an orthogonal split", () => {
    let t: SplitTree = insertPane(leaf(A), "A", B, "right"); // row A|B
    t = insertPane(t, "B", C, "bottom"); // B becomes col B/C
    const s = t as SplitNode;
    expect(s.dir).toBe("row");
    expect(s.children[1]!.type).toBe("split");
    expect((s.children[1] as SplitNode).dir).toBe("col");
    expect(panes(t).map((p) => p.id)).toEqual(["A", "B", "C"]);
  });
  it("leaves the tree unchanged for an unknown target", () => {
    const t = leaf(A);
    expect(insertPane(t, "ZZ", B, "right")).toBe(t);
  });
});

describe("removePane", () => {
  it("collapses a split back to a leaf when one child remains", () => {
    const row = insertPane(leaf(A), "A", B, "right");
    expect(removePane(row, "B")).toEqual(leaf(A));
  });
  it("returns null when the last pane is removed", () => {
    expect(removePane(leaf(A), "A")).toBeNull();
  });
  it("re-normalizes sibling ratios after a removal", () => {
    let t: SplitTree = insertPane(leaf(A), "A", B, "right");
    t = insertPane(t, "B", C, "right"); // A,B,C evenly
    const after = removePane(t, "B") as SplitNode;
    expect(panes(after).map((p) => p.id)).toEqual(["A", "C"]);
    expect(after.ratios.reduce((a, b) => a + b)).toBeCloseTo(1);
  });
});

describe("swapPanes / movePane", () => {
  it("swaps two leaves in place", () => {
    const row = insertPane(leaf(A), "A", B, "right");
    const s = swapPanes(row, "A", "B") as SplitNode;
    expect(panes(s).map((p) => p.id)).toEqual(["B", "A"]);
  });
  it("center move = swap", () => {
    const row = insertPane(leaf(A), "A", B, "right");
    expect(panes(movePane(row, "A", "B", "center")).map((p) => p.id)).toEqual(["B", "A"]);
  });
  it("edge move re-docks and collapses the source slot", () => {
    // row A|B|C ; move A to the right of C → B|C|A
    let t: SplitTree = insertPane(leaf(A), "A", B, "right");
    t = insertPane(t, "B", C, "right");
    const m = movePane(t, "A", "C", "right");
    expect(panes(m).map((p) => p.id)).toEqual(["B", "C", "A"]);
  });
  it("is a no-op moving a pane onto itself or a missing target", () => {
    const row = insertPane(leaf(A), "A", B, "right");
    expect(movePane(row, "A", "A", "center")).toBe(row);
    expect(movePane(row, "A", "ZZ", "right")).toBe(row);
  });
});

describe("resizeDivider", () => {
  it("shifts ratio between neighbors and clamps to the min", () => {
    const row = insertPane(leaf(A), "A", B, "right") as SplitNode;
    const wider = resizeDivider(row, [], 0, 0.2) as SplitNode;
    expect(wider.ratios[0]).toBeCloseTo(0.7);
    expect(wider.ratios[1]).toBeCloseTo(0.3);
    // Over-drag clamps: 0.5+0.9 → clamp to pair-minRatio.
    const clamped = resizeDivider(row, [], 0, 0.9, 0.1) as SplitNode;
    expect(clamped.ratios[0]).toBeCloseTo(0.9);
    expect(clamped.ratios[1]).toBeCloseTo(0.1);
  });
  it("addresses a nested split by path", () => {
    let t: SplitTree = insertPane(leaf(A), "A", B, "right"); // row A|B
    t = insertPane(t, "B", C, "bottom"); // B → col [B, C] at child index 1
    const resized = resizeDivider(t, [1], 0, 0.2) as SplitNode;
    const nested = resized.children[1] as SplitNode;
    expect(nested.ratios[0]).toBeCloseTo(0.7);
    expect(nested.ratios[1]).toBeCloseTo(0.3);
    // The outer ratios are untouched.
    expect(resized.ratios).toEqual([0.5, 0.5]);
  });
  it("no-ops on an out-of-range path or divider index", () => {
    const row = insertPane(leaf(A), "A", B, "right");
    expect(resizeDivider(row, [], 5, 0.2)).toEqual(row);
    expect(resizeDivider(row, [9], 0, 0.2)).toEqual(row);
  });
});

describe("serializeTree / parseTree", () => {
  it("round-trips a nested layout exactly", () => {
    let t: SplitTree = insertPane(leaf(A), "A", B, "right");
    t = insertPane(t, "B", C, "bottom");
    t = insertPane(t, "A", D, "left");
    const back = parseTree(serializeTree(t));
    expect(back).toEqual(t);
    expect(paneCount(back)).toBe(4);
  });
  it("preserves ratios through a round-trip", () => {
    const row = resizeDivider(insertPane(leaf(A), "A", B, "right"), [], 0, 0.15);
    const back = parseTree(serializeTree(row)) as SplitNode;
    expect(back.ratios[0]).toBeCloseTo(0.65);
  });
  it("returns null on garbage / wrong version", () => {
    expect(parseTree(null)).toBeNull();
    expect(parseTree("{bad")).toBeNull();
    expect(parseTree(JSON.stringify({ v: 99, tree: {} }))).toBeNull();
  });
  it("recovers gracefully when a leaf's pane is corrupt", () => {
    // A split with one bad + one good leaf collapses to the good one.
    const doc = JSON.stringify({
      v: 1,
      tree: { t: "s", d: "row", c: [{ t: "l", p: { source: {} } }, { t: "l", p: A }], r: [0.5, 0.5] },
    });
    expect(parseTree(doc)).toEqual(leaf(A));
  });
});

describe("singleLeaf / findPane", () => {
  it("builds a single-leaf tree and finds panes by id", () => {
    const t = singleLeaf(A);
    expect(t).toEqual(leaf(A));
    expect(findPane(t, "A")).toEqual(A);
    expect(findPane(t, "nope")).toBeNull();
  });
});
