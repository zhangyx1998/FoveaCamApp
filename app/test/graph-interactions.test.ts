// Profiler graph interactions — the PURE decision logic behind the
// node-graph canvas interactions (graph-interactions.ts): ctrl-wheel zoom
// gating + zoom math, the dragged-position preservation merge, edge-path
// geometry, and the profiler report-rate parsing. DOM/fullscreen wiring stays
// thin and untested by design. (The graph emits `edgePath` SVG cubics directly.)

import { describe, expect, it } from "vitest";
import {
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
  edgePath,
  STEM_MIN_PX,
  STEM_MAX_PX,
  LANE_STEP_PX,
} from "@src/profiler/graph-interactions";

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

describe("perpendicular-stem edge geometry", () => {
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

  // edgePath emits "M sx sy C c1x c1y, c2x c2y, tx ty" — a cubic whose control
  // points sit `off` px horizontally off each endpoint (stems leave/enter the
  // LR faces perpendicular). Parse the six numbers back out and check them.
  const NUM = "(-?[\\d.]+)";
  const CUBIC = new RegExp(
    `^M ${NUM} ${NUM} C ${NUM} ${NUM}, ${NUM} ${NUM}, ${NUM} ${NUM}$`,
  );
  function parse(d: string) {
    const m = CUBIC.exec(d)!;
    const n = m.slice(1).map(Number);
    return {
      s: { x: n[0]!, y: n[1]! },
      c1: { x: n[2]!, y: n[3]! },
      c2: { x: n[4]!, y: n[5]! },
      t: { x: n[6]!, y: n[7]! },
    };
  }

  it("places both control points on the horizontal face normals (diagonal edge)", () => {
    const s = { x: 0, y: 0 };
    const t = { x: 200, y: 120 };
    const off = stemOffset(Math.hypot(200, 120));
    const p = parse(edgePath(s, t));
    // Endpoints round-trip; C1 sits `off` RIGHT of the source at the source's
    // height (stem leaves horizontally); C2 sits `off` LEFT of the target.
    expect(p.s).toEqual(s);
    expect(p.t).toEqual(t);
    expect(p.c1.x).toBeCloseTo(s.x + off);
    expect(p.c1.y).toBeCloseTo(s.y);
    expect(p.c2.x).toBeCloseTo(t.x - off);
    expect(p.c2.y).toBeCloseTo(t.y);
  });

  it("keeps stems horizontal on a back-edge (target left of source)", () => {
    const s = { x: 300, y: 40 };
    const t = { x: 60, y: 90 }; // feedback loop — target to the LEFT
    const off = stemOffset(Math.hypot(-240, 50));
    const p = parse(edgePath(s, t));
    expect(p.c1.x).toBeCloseTo(s.x + off); // still leaves the source's RIGHT face
    expect(p.c1.y).toBeCloseTo(s.y);
    expect(p.c2.x).toBeCloseTo(t.x - off); // still enters the target's LEFT face
    expect(p.c2.y).toBeCloseTo(t.y);
  });

  it("collapses coincident endpoints to a straight no-op segment (degenerate)", () => {
    // Truly identical points → zero-length "M s L t"; the panel never divides
    // by a zero-length stem.
    expect(edgePath({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe("M 5 5 L 5 5");
    // Sub-epsilon separation also degrades to the straight fallback.
    expect(edgePath({ x: 0, y: 0 }, { x: 1e-9, y: 0 })).toMatch(/^M 0 0 L /);
  });
});
