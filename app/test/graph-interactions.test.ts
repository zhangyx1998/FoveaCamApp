// D-item-3 profiler graph interactions — the PURE decision logic behind
// GraphPanel's canvas interactions (graph-interactions.ts): height
// clamp/persist round-trip, ctrl-wheel zoom gating + zoom math, the
// dragged-position preservation merge, and the profiler report-rate parsing.
// DOM/fullscreen/cytoscape wiring stays thin and untested by design.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_HEIGHT,
  MIN_GRAPH_HEIGHT,
  clampGraphHeight,
  parseGraphHeight,
  isZoomGesture,
  nextZoomLevel,
  ZOOM_MIN,
  ZOOM_MAX,
  reconcileDraggedPositions,
  DEFAULT_REPORT_INTERVAL_MS,
  parseReportInterval,
  REPORT_INTERVAL_OPTIONS,
  stemOffset,
  laneOffset,
  perpendicularControlPoints,
  STEM_MIN_PX,
  STEM_MAX_PX,
  LANE_STEP_PX,
} from "@src/profiler/graph-interactions";

describe("graph height clamp + persist round-trip", () => {
  it("clamps below the minimum and rounds fractional drag deltas", () => {
    expect(clampGraphHeight(120)).toBe(MIN_GRAPH_HEIGHT);
    expect(clampGraphHeight(MIN_GRAPH_HEIGHT)).toBe(MIN_GRAPH_HEIGHT);
    expect(clampGraphHeight(512.6)).toBe(513);
    expect(clampGraphHeight(NaN)).toBe(DEFAULT_GRAPH_HEIGHT);
    expect(clampGraphHeight(Infinity)).toBe(DEFAULT_GRAPH_HEIGHT);
  });

  it("round-trips through the localStorage string representation", () => {
    const h = clampGraphHeight(457.2);
    expect(parseGraphHeight(String(h))).toBe(h);
  });

  it("falls back to the default on absent or garbage persisted values", () => {
    expect(parseGraphHeight(null)).toBe(DEFAULT_GRAPH_HEIGHT);
    expect(parseGraphHeight("")).toBe(DEFAULT_GRAPH_HEIGHT);
    expect(parseGraphHeight("not-a-number")).toBe(DEFAULT_GRAPH_HEIGHT);
    // A persisted value below today's minimum is clamped up, not trusted.
    expect(parseGraphHeight("50")).toBe(MIN_GRAPH_HEIGHT);
  });
});

describe("wheel-event zoom gating (ctrl vs plain)", () => {
  it("zooms only with ctrlKey (macOS pinch arrives as ctrl+wheel)", () => {
    expect(isZoomGesture({ ctrlKey: true })).toBe(true); // ctrl+wheel AND pinch
    expect(isZoomGesture({ ctrlKey: false })).toBe(false); // plain scroll → page
  });

  it("zoom math: deltaY<0 zooms in, multiplicative, clamped both ends", () => {
    const zoomedIn = nextZoomLevel(1, -100);
    const zoomedOut = nextZoomLevel(1, 100);
    expect(zoomedIn).toBeGreaterThan(1);
    expect(zoomedOut).toBeLessThan(1);
    // Symmetric feel: in then out by the same delta returns to start.
    expect(nextZoomLevel(zoomedIn, 100)).toBeCloseTo(1, 10);
    expect(nextZoomLevel(ZOOM_MAX, -1000)).toBe(ZOOM_MAX);
    expect(nextZoomLevel(ZOOM_MIN, 1000)).toBe(ZOOM_MIN);
  });
});

describe("dragged-position preservation across topology refreshes", () => {
  it("keeps positions for surviving nodes, prunes departed ones", () => {
    const dragged = new Map([
      ["camera/123/convert", { x: 10, y: 20 }],
      ["camera/999/undistort", { x: 5, y: 5 }], // node left the graph
    ]);
    const next = reconcileDraggedPositions(dragged, ["camera/123", "camera/123/convert"]);
    expect([...next.keys()]).toEqual(["camera/123/convert"]);
    expect(next.get("camera/123/convert")).toEqual({ x: 10, y: 20 });
  });

  it("never mutates the input map (re-layout decision stays pure)", () => {
    const dragged = new Map([["a", { x: 1, y: 2 }]]);
    const next = reconcileDraggedPositions(dragged, []);
    expect(next.size).toBe(0);
    expect(dragged.size).toBe(1);
  });

  it("empty dragged set → nothing to re-apply (auto-layout owns all nodes)", () => {
    expect(reconcileDraggedPositions(new Map(), ["a", "b"]).size).toBe(0);
  });
});

describe("profiler report interval parsing", () => {
  it("accepts exactly the offered options", () => {
    for (const { ms } of REPORT_INTERVAL_OPTIONS) {
      expect(parseReportInterval(String(ms))).toBe(ms);
    }
  });

  it("falls back to 1 s on absent/garbage/off-menu values", () => {
    expect(DEFAULT_REPORT_INTERVAL_MS).toBe(1000);
    expect(parseReportInterval(null)).toBe(1000);
    expect(parseReportInterval("")).toBe(1000);
    expect(parseReportInterval("250")).toBe(1000);
    expect(parseReportInterval("fast")).toBe(1000);
  });
});

describe("perpendicular-stem edge geometry (user ruling 1)", () => {
  it("scales the stem with edge length, clamped both ends", () => {
    expect(stemOffset(10)).toBe(STEM_MIN_PX); // 3.5 < min → clamp up
    expect(stemOffset(200)).toBeCloseTo(70); // 200 * 0.35
    expect(stemOffset(10000)).toBe(STEM_MAX_PX); // clamp down
  });

  it("fans same-direction parallels symmetrically about the face midpoint", () => {
    expect(laneOffset(0, 1)).toBe(0); // a lone edge attaches at the midpoint
    // two parallels straddle the midpoint by ±half a step
    expect(laneOffset(0, 2)).toBeCloseTo(-LANE_STEP_PX / 2);
    expect(laneOffset(1, 2)).toBeCloseTo(LANE_STEP_PX / 2);
    // three: one on the midpoint, one above, one below
    expect(laneOffset(1, 3)).toBe(0);
    expect(laneOffset(0, 3)).toBeCloseTo(-LANE_STEP_PX);
  });

  // Reconstruct cytoscape's own control-point placement (edge-distances:
  // endpoints): P = S + w·(T−S) + d·n, with n = (−dy, dx)/l. The returned
  // (weight, distance) pairs must land C1 horizontally off S and C2 horizontally
  // off T — i.e. the stems leave/enter the LR faces perpendicular.
  function reconstruct(s: { x: number; y: number }, t: { x: number; y: number }) {
    const cp = perpendicularControlPoints(s, t)!;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const l = Math.hypot(dx, dy);
    const n = { x: -dy / l, y: dx / l };
    const at = (w: number, d: number) => ({
      x: s.x + w * dx + d * n.x,
      y: s.y + w * dy + d * n.y,
    });
    return { c1: at(cp.weights[0], cp.distances[0]), c2: at(cp.weights[1], cp.distances[1]) };
  }

  it("places both control points on the horizontal face normals (diagonal edge)", () => {
    const s = { x: 0, y: 0 };
    const t = { x: 200, y: 120 };
    const off = stemOffset(Math.hypot(200, 120));
    const { c1, c2 } = reconstruct(s, t);
    // C1 sits `off` to the RIGHT of the source at the source's height (stem
    // leaves horizontally); C2 sits `off` to the LEFT of the target at its height.
    expect(c1.x).toBeCloseTo(s.x + off);
    expect(c1.y).toBeCloseTo(s.y);
    expect(c2.x).toBeCloseTo(t.x - off);
    expect(c2.y).toBeCloseTo(t.y);
  });

  it("keeps stems horizontal on a back-edge (target left of source)", () => {
    const s = { x: 300, y: 40 };
    const t = { x: 60, y: 90 }; // feedback loop — target to the LEFT
    const off = stemOffset(Math.hypot(-240, 50));
    const { c1, c2 } = reconstruct(s, t);
    expect(c1.x).toBeCloseTo(s.x + off); // still leaves the source's RIGHT face
    expect(c1.y).toBeCloseTo(s.y);
    expect(c2.x).toBeCloseTo(t.x - off); // still enters the target's LEFT face
    expect(c2.y).toBeCloseTo(t.y);
  });

  it("returns null for coincident endpoints (degenerate)", () => {
    expect(perpendicularControlPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull();
  });
});
