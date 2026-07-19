// Profiler hover-card placement — the PURE placement math behind the
// two hover-card behaviors (follow / corner). DOM/pointer wiring in NodeGraph.vue
// stays thin and untested by design; this pins the geometry.

import { describe, expect, it } from "vitest";
import {
  followPlacement,
  cornerPlacement,
  type Box,
} from "@src/profiler/hover-card-placement";

const container = { w: 1000, h: 800 };
const card = { w: 200, h: 120 };
const offset = 12;

describe("followPlacement — quadrant auto-flip", () => {
  it("prefers below-right of the cursor when it fits", () => {
    const p = followPlacement({ x: 100, y: 100 }, card, container, offset);
    expect(p).toEqual({ x: 112, y: 112 });
  });

  it("flips LEFT when the card would overflow the right edge", () => {
    const p = followPlacement({ x: 950, y: 100 }, card, container, offset);
    // right-flip → left of cursor: 950 - 12 - 200 = 738
    expect(p.x).toBe(738);
    expect(p.x + card.w).toBeLessThanOrEqual(container.w);
    expect(p.y).toBe(112); // vertical still below
  });

  it("flips UP when the card would overflow the bottom edge", () => {
    const p = followPlacement({ x: 100, y: 760 }, card, container, offset);
    expect(p.x).toBe(112); // horizontal still right
    // bottom-flip → above cursor: 760 - 12 - 120 = 628
    expect(p.y).toBe(628);
    expect(p.y + card.h).toBeLessThanOrEqual(container.h);
  });

  it("flips BOTH ways in the bottom-right corner", () => {
    const p = followPlacement({ x: 950, y: 760 }, card, container, offset);
    expect(p.x).toBe(738);
    expect(p.y).toBe(628);
    expect(p.x + card.w).toBeLessThanOrEqual(container.w);
    expect(p.y + card.h).toBeLessThanOrEqual(container.h);
  });

  it("stays fully inside near the top-left origin (no negative offsets)", () => {
    const p = followPlacement({ x: 2, y: 2 }, card, container, offset);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });

  it("degenerate: card larger than a tiny container pins to top-left", () => {
    const p = followPlacement({ x: 5, y: 5 }, { w: 300, h: 200 }, { w: 100, h: 80 }, offset);
    expect(p).toEqual({ x: 0, y: 0 });
    expect(Number.isNaN(p.x)).toBe(false);
    expect(Number.isNaN(p.y)).toBe(false);
  });
});

describe("cornerPlacement — non-covering corner selection", () => {
  it("picks a corner whose card rect does not cover the hovered item", () => {
    // Item pinned to the top-left region; the winning corner must avoid it.
    const item: Box = { x: 20, y: 20, w: 150, h: 100 };
    const p = cornerPlacement(item, { x: 90, y: 70 }, card, container, 8);
    const rect: Box = { x: p.x, y: p.y, w: card.w, h: card.h };
    const overlapW = Math.max(0, Math.min(rect.x + rect.w, item.x + item.w) - Math.max(rect.x, item.x));
    const overlapH = Math.max(0, Math.min(rect.y + rect.h, item.y + item.h) - Math.max(rect.y, item.y));
    expect(overlapW * overlapH).toBe(0); // no overlap with the hovered item
  });

  it("respects the margin from the container edges", () => {
    const item: Box = { x: 400, y: 350, w: 60, h: 60 }; // central → all corners tie on overlap
    const margin = 16;
    const p = cornerPlacement(item, { x: 430, y: 380 }, card, container, margin);
    // Whichever corner is chosen, it is inset by exactly `margin`.
    const atLeftMargin = p.x === margin;
    const atRightMargin = p.x === container.w - card.w - margin;
    const atTopMargin = p.y === margin;
    const atBottomMargin = p.y === container.h - card.h - margin;
    expect(atLeftMargin || atRightMargin).toBe(true);
    expect(atTopMargin || atBottomMargin).toBe(true);
  });

  it("ties break toward the corner farthest from the cursor", () => {
    // Central item → every corner has zero item overlap (a tie); cursor sits in
    // the top-left, so the winning corner should be the bottom-right one.
    const item: Box = { x: 480, y: 380, w: 40, h: 40 };
    const p = cornerPlacement(item, { x: 60, y: 60 }, card, container, 8);
    expect(p.x).toBe(container.w - card.w - 8); // right corner
    expect(p.y).toBe(container.h - card.h - 8); // bottom corner
  });

  it("degenerate: tiny container never yields NaN / negative offsets", () => {
    const item: Box = { x: 0, y: 0, w: 20, h: 20 };
    const p = cornerPlacement(item, { x: 10, y: 10 }, { w: 300, h: 200 }, { w: 100, h: 80 }, 8);
    expect(Number.isNaN(p.x)).toBe(false);
    expect(Number.isNaN(p.y)).toBe(false);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });
});
