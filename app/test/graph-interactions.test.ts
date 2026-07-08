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
