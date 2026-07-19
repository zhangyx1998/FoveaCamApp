// Profiler node-graph VIEWPORT algebra (graph-viewport.ts) — the pure
// screen/model transform + pan clamp + pointer zoom + contain-fit + resize
// refit behind the hand-rolled NodeGraph component. DOM/wheel wiring stays thin.

import { describe, expect, it } from "vitest";
import {
  type Box,
  type Size,
  type Viewport,
  ZOOM_MIN,
  ZOOM_MAX,
  FIT_ZOOM_MAX,
  FIT_PADDING,
  intersect,
  modelToScreen,
  screenToModel,
  viewportBox,
  viewportContent,
  clampPan,
  panBy,
  zoomAt,
  fitBox,
  resizeViewport,
} from "@src/profiler/graph-viewport";

const centerModel = (vp: Viewport, c: Size): { x: number; y: number } =>
  screenToModel({ x: c.w / 2, y: c.h / 2 }, vp);

const contains = (outer: Box, inner: Box, eps = 1e-6): boolean =>
  outer.x <= inner.x + eps &&
  outer.y <= inner.y + eps &&
  outer.x + outer.w >= inner.x + inner.w - eps &&
  outer.y + outer.h >= inner.y + inner.h - eps;

describe("screen ⇄ model round-trip (screen = model·zoom + pan)", () => {
  it("screenToModel is the exact inverse of modelToScreen", () => {
    const vp: Viewport = { zoom: 1.7, pan: { x: -42, y: 88 } };
    for (const m of [
      { x: 0, y: 0 },
      { x: 123.5, y: -60 },
      { x: -900, y: 400 },
    ]) {
      const s = modelToScreen(m, vp);
      const back = screenToModel(s, vp);
      expect(back.x).toBeCloseTo(m.x, 9);
      expect(back.y).toBeCloseTo(m.y, 9);
    }
  });

  it("viewportBox is the model box that maps onto the container corners", () => {
    const vp: Viewport = { zoom: 2, pan: { x: 100, y: 50 } };
    const c: Size = { w: 800, h: 600 };
    const vb = viewportBox(vp, c);
    // top-left corner ← screenToModel(0,0); size = container / zoom
    expect(vb).toMatchObject({ x: -50, y: -25, w: 400, h: 300 });
    // its screen projection is exactly the container rect
    expect(modelToScreen({ x: vb.x, y: vb.y }, vp)).toEqual({ x: 0, y: 0 });
    expect(modelToScreen({ x: vb.x + vb.w, y: vb.y + vb.h }, vp)).toEqual({
      x: 800,
      y: 600,
    });
  });
});

describe("intersect", () => {
  it("returns the overlap and null when disjoint / merely touching", () => {
    expect(intersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 })).toEqual({
      x: 50,
      y: 50,
      w: 50,
      h: 50,
    });
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBeNull();
    // edge-touch (zero-area) counts as no overlap
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBeNull();
  });
});

describe("clampPan — the center model point stays in the graph bbox", () => {
  const graph: Box = { x: 0, y: 0, w: 1000, h: 800 };
  const c: Size = { w: 400, h: 300 };

  it("pins the center to each of the four bbox edges when panned past it", () => {
    // pan.x too large drags the center off the LEFT edge → clamps to graph.x
    let vp = clampPan({ zoom: 1, pan: { x: 5000, y: 0 } }, c, graph);
    expect(centerModel(vp, c).x).toBeCloseTo(graph.x);
    // pan.x too small → RIGHT edge
    vp = clampPan({ zoom: 1, pan: { x: -5000, y: 0 } }, c, graph);
    expect(centerModel(vp, c).x).toBeCloseTo(graph.x + graph.w);
    // pan.y too large → TOP edge
    vp = clampPan({ zoom: 1, pan: { x: 0, y: 5000 } }, c, graph);
    expect(centerModel(vp, c).y).toBeCloseTo(graph.y);
    // pan.y too small → BOTTOM edge
    vp = clampPan({ zoom: 1, pan: { x: 0, y: -5000 } }, c, graph);
    expect(centerModel(vp, c).y).toBeCloseTo(graph.y + graph.h);
  });

  it("leaves an already-centered viewport untouched", () => {
    // center of the graph under the container center
    const vp: Viewport = { zoom: 1, pan: { x: c.w / 2 - 500, y: c.h / 2 - 400 } };
    const out = clampPan(vp, c, graph);
    expect(out.pan).toEqual(vp.pan);
    expect(centerModel(out, c)).toMatchObject({ x: 500, y: 400 });
  });

  it("pins the center to a degenerate zero-size graph's point", () => {
    const point: Box = { x: 120, y: 60, w: 0, h: 0 };
    const vp = clampPan({ zoom: 3, pan: { x: 9999, y: -9999 } }, c, point);
    const m = centerModel(vp, c);
    expect(m.x).toBeCloseTo(120);
    expect(m.y).toBeCloseTo(60);
  });

  it("panBy scrolls then clamps (never escapes the bbox)", () => {
    const start: Viewport = { zoom: 1, pan: { x: c.w / 2 - 500, y: c.h / 2 - 400 } };
    const out = panBy(start, 100000, 100000, c, graph);
    const m = centerModel(out, c);
    expect(m.x).toBeGreaterThanOrEqual(graph.x - 1e-6);
    expect(m.x).toBeLessThanOrEqual(graph.x + graph.w + 1e-6);
    expect(m.y).toBeGreaterThanOrEqual(graph.y - 1e-6);
    expect(m.y).toBeLessThanOrEqual(graph.y + graph.h + 1e-6);
  });
});

describe("zoomAt — the model point under the pointer stays fixed", () => {
  // A graph large enough that clampPan never binds, so the fixed-point property
  // is exact.
  const graph: Box = { x: -10000, y: -10000, w: 20000, h: 20000 };
  const c: Size = { w: 800, h: 600 };

  it("keeps the model point under the pointer on screen across the zoom", () => {
    const vp: Viewport = { zoom: 1, pan: { x: 0, y: 0 } };
    const pointer = { x: 300, y: 200 };
    const before = screenToModel(pointer, vp);
    const out = zoomAt(vp, 2, pointer, c, graph);
    expect(out.zoom).toBe(2);
    const after = modelToScreen(before, out);
    expect(after.x).toBeCloseTo(pointer.x, 6);
    expect(after.y).toBeCloseTo(pointer.y, 6);
  });

  it("clamps the target zoom to [ZOOM_MIN, ZOOM_MAX]", () => {
    const vp: Viewport = { zoom: 1, pan: { x: 0, y: 0 } };
    expect(zoomAt(vp, 1000, { x: 400, y: 300 }, c, graph).zoom).toBe(ZOOM_MAX);
    expect(zoomAt(vp, 0.0001, { x: 400, y: 300 }, c, graph).zoom).toBe(ZOOM_MIN);
  });
});

describe("fitBox — contain-fit + center", () => {
  const c: Size = { w: 800, h: 600 };

  it("picks the smaller axis ratio (contain) and centers the target", () => {
    const target: Box = { x: 0, y: 0, w: 1600, h: 400 }; // wide → width-bound
    const vp = fitBox(target, c, 0);
    expect(vp.zoom).toBeCloseTo(0.5); // min(800/1600, 600/400)=0.5
    // target center maps to container center
    const tc = modelToScreen({ x: 800, y: 200 }, vp);
    expect(tc.x).toBeCloseTo(400);
    expect(tc.y).toBeCloseTo(300);
    // the whole target is visible in the fitted viewport
    expect(contains(viewportBox(vp, c), target)).toBe(true);
  });

  it("never magnifies a tiny graph past the cap, still centered", () => {
    const target: Box = { x: 10, y: 10, w: 20, h: 20 };
    const vp = fitBox(target, c, 0);
    expect(vp.zoom).toBe(FIT_ZOOM_MAX);
    const tc = modelToScreen({ x: 20, y: 20 }, vp);
    expect(tc.x).toBeCloseTo(400);
    expect(tc.y).toBeCloseTo(300);
  });

  it("floors a huge graph at ZOOM_MIN and centers a degenerate target", () => {
    expect(fitBox({ x: 0, y: 0, w: 1_000_000, h: 1_000_000 }, c, 0).zoom).toBe(ZOOM_MIN);
    const deg = fitBox({ x: 40, y: 25, w: 0, h: 0 }, c, 0);
    expect(deg.zoom).toBe(FIT_ZOOM_MAX); // zero-size → cap zoom
    expect(modelToScreen({ x: 40, y: 25 }, deg)).toMatchObject({ x: 400, y: 300 });
  });

  it("default padding shrinks the fit vs zero padding", () => {
    const target: Box = { x: 0, y: 0, w: 1600, h: 1200 };
    const padded = fitBox(target, c); // default FIT_PADDING
    const tight = fitBox(target, c, 0);
    expect(FIT_PADDING).toBeGreaterThan(0);
    expect(padded.zoom).toBeLessThan(tight.zoom);
  });
});

describe("viewportContent — visible model content", () => {
  const graph: Box = { x: 0, y: 0, w: 100, h: 100 };

  it("is the intersection of the visible box and the graph bbox", () => {
    const vp: Viewport = { zoom: 1, pan: { x: 0, y: 0 } };
    expect(viewportContent(vp, { w: 50, h: 50 }, graph)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
  });

  it("is null when the viewport shows none of the graph", () => {
    const vp: Viewport = { zoom: 1, pan: { x: -1000, y: 0 } }; // visible box far to the right
    expect(viewportContent(vp, { w: 200, h: 200 }, graph)).toBeNull();
  });
});

describe("resizeViewport — keep the same model content on container resize", () => {
  it("first reveal from a 0×0 box fits the WHOLE graph bbox", () => {
    const graph: Box = { x: 0, y: 0, w: 1000, h: 600 };
    const vp: Viewport = { zoom: 1, pan: { x: 0, y: 0 } };
    const out = resizeViewport(vp, { w: 0, h: 0 }, { w: 800, h: 600 }, graph);
    // the whole graph is visible (contain-fit of the whole bbox)
    expect(contains(viewportBox(out, { w: 800, h: 600 }), graph)).toBe(true);
    // and it is centered
    const gc = modelToScreen({ x: 500, y: 300 }, out);
    expect(gc.x).toBeCloseTo(400);
    expect(gc.y).toBeCloseTo(300);
  });

  it("preserves the visible content across a fullscreen-style size jump", () => {
    const graph: Box = { x: 0, y: 0, w: 2000, h: 1500 };
    // zoomed into a 400×300 window over model region [500,900]×[300,600]
    const vp: Viewport = { zoom: 1, pan: { x: -500, y: -300 } };
    const prev: Size = { w: 400, h: 300 };
    const next: Size = { w: 1200, h: 900 };
    const content = viewportContent(vp, prev, graph)!;
    expect(content).toEqual({ x: 500, y: 300, w: 400, h: 300 });
    const out = resizeViewport(vp, prev, next, graph);
    // the previously-visible content is still on screen after the jump…
    expect(contains(viewportBox(out, next), content)).toBe(true);
    // …and centered
    const cc = modelToScreen({ x: 700, y: 450 }, out);
    expect(cc.x).toBeCloseTo(600);
    expect(cc.y).toBeCloseTo(450);
  });

  it("falls back to the whole graph when nothing was visible (null content)", () => {
    const graph: Box = { x: 0, y: 0, w: 500, h: 400 };
    const vp: Viewport = { zoom: 1, pan: { x: -5000, y: 0 } }; // graph off-screen
    expect(viewportContent(vp, { w: 300, h: 300 }, graph)).toBeNull();
    const out = resizeViewport(vp, { w: 300, h: 300 }, { w: 900, h: 700 }, graph);
    expect(contains(viewportBox(out, { w: 900, h: 700 }), graph)).toBe(true);
  });
});
