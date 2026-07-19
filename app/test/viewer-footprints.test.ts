// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure fovea-footprint model (fovea-footprint-overlay): corner projection
// through a known homography, pair derivation from channel naming, greedy
// interval-coloring (overlap → distinct, disjoint → reused, pair shares color),
// and the vergence-plane depth from synthetic angles. No Vue/Node/core.

import { describe, expect, it } from "vitest";
import {
  assignColors,
  footprintSide,
  groupByStream,
  groupStreams,
  projectQuad,
  quadPoints,
  vergencePlaneDepth,
  formatDepth,
} from "@src/viewer/footprints";

// ---- corner projection ----------------------------------------------------

describe("projectQuad", () => {
  it("maps the 4 corners through an affine (translate+scale) homography", () => {
    // Row-major H: x' = 2x + 10, y' = 3y + 20 (w'=1).
    const H = [2, 0, 10, 0, 3, 20, 0, 0, 1];
    const quad = projectQuad(H, 4, 5);
    expect(quad).toEqual([
      { x: 10, y: 20 }, // (0,0)
      { x: 18, y: 20 }, // (4,0)
      { x: 18, y: 35 }, // (4,5)
      { x: 10, y: 35 }, // (0,5)
    ]);
  });

  it("applies the perspective divide (w' ≠ 1)", () => {
    // x' = x/(x*0.5 + 1); at x=2 → w'=2 → x'=1.
    const H = [1, 0, 0, 0, 1, 0, 0.5, 0, 1];
    const quad = projectQuad(H, 2, 2)!;
    expect(quad[1]!.x).toBeCloseTo(1); // (2,0) → 2/2
    expect(quad[0]).toEqual({ x: 0, y: 0 }); // w'=1 at origin
  });

  it("returns null for a bad affine, non-positive dims, or a degenerate corner", () => {
    expect(projectQuad([1, 2, 3], 4, 5)).toBeNull(); // too short
    expect(projectQuad(undefined, 4, 5)).toBeNull();
    expect(projectQuad([1, 0, 0, 0, 1, 0, 0, 0, 1], 0, 5)).toBeNull(); // w=0
    // A homography that sends corner (w,h) to w'=0 (on the horizon).
    const H = [1, 0, 0, 0, 1, 0, -1 / 4, 0, 1]; // w' = 1 - x/4 → 0 at x=4
    expect(projectQuad(H, 4, 5)).toBeNull();
  });

  it("quadPoints serialises an SVG points string", () => {
    expect(quadPoints([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe("1,2 3,4");
  });
});

// ---- pairing --------------------------------------------------------------

describe("footprintSide / groupStreams", () => {
  it("pairs the sole left/right (empty base) — the multi-fovea stereo pair", () => {
    expect(footprintSide("left")).toEqual({ side: "left", base: "" });
    expect(footprintSide("right")).toEqual({ side: "right", base: "" });
    expect(footprintSide("center")).toBeNull();

    const groups = groupStreams(["left", "center", "right"]);
    const pair = groups.find((g) => g.left && g.right);
    expect(pair).toBeTruthy();
    expect(pair!.streams.sort()).toEqual(["left", "right"]);
    // "center" is a solo group.
    expect(groups.find((g) => g.streams.length === 1 && g.streams[0] === "center")).toBeTruthy();
  });

  it("pairs by shared base after stripping the side token", () => {
    const groups = groupStreams(["cam-left", "cam-right", "wide"]);
    const pair = groups.find((g) => g.key === "pair:cam");
    expect(pair).toBeTruthy();
    expect(pair!.left).toBe("cam-left");
    expect(pair!.right).toBe("cam-right");
  });

  it("does NOT pair an ambiguous base (two lefts) — each becomes a solo", () => {
    const groups = groupStreams(["a-left", "b-left", "a-right"]);
    // base "a" has one L + one R → pair; "b-left" solo.
    expect(groups.find((g) => g.key === "pair:a")).toBeTruthy();
    // Force a genuine ambiguity: two lefts, one right, same base.
    const amb = groupStreams(["x-left", "x-left-2", "x-right"]);
    // "x-left" (base x) + "x-right" (base x) pair; "x-left-2" (base x-2) solo.
    expect(amb.some((g) => g.left === "x-left" && g.right === "x-right")).toBe(true);
  });

  it("groupByStream maps every member back to its group", () => {
    const groups = groupStreams(["left", "right", "center"]);
    const by = groupByStream(groups);
    expect(by.get("left")).toBe(by.get("right")); // same pair group
    expect(by.get("center")!.streams).toEqual(["center"]);
  });
});

// ---- interval coloring ----------------------------------------------------

describe("assignColors", () => {
  it("gives OVERLAPPING intervals distinct colors", () => {
    const c = assignColors([
      { key: "a", startNs: 0, lastNs: 100 },
      { key: "b", startNs: 50, lastNs: 150 },
    ]);
    expect(c.get("a")).not.toBe(c.get("b"));
  });

  it("REUSES a color for DISJOINT intervals", () => {
    const c = assignColors([
      { key: "a", startNs: 0, lastNs: 100 },
      { key: "b", startNs: 100, lastNs: 200 }, // touches at a point → disjoint
      { key: "c", startNs: 300, lastNs: 400 },
    ]);
    expect(c.get("a")).toBe(0);
    expect(c.get("b")).toBe(0); // reused (no strict overlap)
    expect(c.get("c")).toBe(0);
  });

  it("a single pair group gets one color (both eyes share it downstream)", () => {
    // The pair is ONE interval (its members' union) → one color index.
    const c = assignColors([{ key: "pair:", startNs: 0, lastNs: 1000 }]);
    expect(c.get("pair:")).toBe(0);
  });

  it("three mutually-overlapping intervals get three distinct colors", () => {
    const c = assignColors([
      { key: "a", startNs: 0, lastNs: 100 },
      { key: "b", startNs: 10, lastNs: 110 },
      { key: "c", startNs: 20, lastNs: 120 },
    ]);
    expect(new Set([c.get("a"), c.get("b"), c.get("c")]).size).toBe(3);
  });
});

// ---- vergence-plane depth -------------------------------------------------

describe("vergencePlaneDepth / formatDepth", () => {
  it("computes a positive depth from a toe-in vergence + baseline", () => {
    // aL.x - aR.x = vergence; d = (baseline/2) / tan(vergence/2) — the EXACT
    // symmetric-fixation inverse (round-trip pinned in
    // app/test/stereo-q.test.ts).
    const baseline = 200; // mm
    const vergence = 0.1; // rad toe-in
    const d = vergencePlaneDepth(vergence, 0, baseline)!;
    expect(d).toBeCloseTo(baseline / 2 / Math.tan(vergence / 2), 3);
    expect(d).toBeGreaterThan(0);
  });

  it("returns null when a partner angle or the baseline is missing/invalid", () => {
    expect(vergencePlaneDepth(0.1, null, 200)).toBeNull(); // no partner
    expect(vergencePlaneDepth(0.1, 0, null)).toBeNull(); // no baseline
    expect(vergencePlaneDepth(0.1, 0, 0)).toBeNull(); // baseline ≤ 0
    expect(vergencePlaneDepth(undefined, 0, 200)).toBeNull();
  });

  it("returns Infinity for parallel/diverging rays (no convergence)", () => {
    expect(vergencePlaneDepth(0, 0, 200)).toBe(Infinity);
  });

  it("formatDepth: — (null), ∞ (parallel), mm / m otherwise", () => {
    expect(formatDepth(null)).toBe("—");
    expect(formatDepth(Infinity)).toBe("∞");
    expect(formatDepth(350)).toBe("350 mm");
    expect(formatDepth(2500)).toBe("2.50 m");
  });
});
