// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure time-axis viewport algebra (time-viewport.ts): zoom fixed-point, span
// clamps, rubber-band pan + hard bleed bound, settle legality/identity, x↔ns
// round-trip, ruler nice steps/density/negative labels, playhead interpolation.

import { describe, expect, it } from "vitest";
import {
  BLEED_FRACTION,
  MIN_SPAN_NS,
  bleedNs,
  fracOf,
  fullViewport,
  interpolatePlayhead,
  nsAtX,
  panSoft,
  rulerTicks,
  settleTarget,
  zoomAt,
  type TimeViewport,
} from "@src/viewer/time-viewport";

const D = 10e9; // 10 s recording
const bleed = bleedNs(D); // 0.05 * 10e9 = 5e8

describe("fullViewport / bleedNs", () => {
  it("full viewport spans [0, duration]", () => {
    expect(fullViewport(D)).toEqual({ t0: 0, t1: D });
  });
  it("bleed is BLEED_FRACTION of the duration, floored at 0", () => {
    expect(bleedNs(D)).toBeCloseTo(BLEED_FRACTION * D, 6);
    expect(bleedNs(0)).toBe(0);
    expect(bleedNs(-5)).toBe(0);
  });
});

describe("zoomAt", () => {
  it("keeps the time under the anchor fixed (away from bounds)", () => {
    const vp: TimeViewport = { t0: 2e9, t1: 6e9 };
    const anchor = 0.25;
    const anchorNs = vp.t0 + anchor * (vp.t1 - vp.t0); // 3e9
    const zoomed = zoomAt(vp, 2, anchor, D); // zoom IN 2×
    const at = zoomed.t0 + anchor * (zoomed.t1 - zoomed.t0);
    expect(at).toBeCloseTo(anchorNs, 3);
    // Span halved on a 2× zoom-in.
    expect(zoomed.t1 - zoomed.t0).toBeCloseTo((vp.t1 - vp.t0) / 2, 3);
  });

  it("clamps span at the zoom-in floor (MIN_SPAN_NS)", () => {
    const vp: TimeViewport = { t0: 4e9, t1: 6e9 };
    const zoomed = zoomAt(vp, 1e12, 0.5, D); // absurd zoom-in
    expect(zoomed.t1 - zoomed.t0).toBeCloseTo(MIN_SPAN_NS, 3);
  });

  it("clamps span at the zoom-out ceiling (duration + 2·bleed) within bleed bounds", () => {
    const vp: TimeViewport = { t0: 4e9, t1: 6e9 };
    const zoomed = zoomAt(vp, 1e-12, 0.5, D); // absurd zoom-out
    expect(zoomed.t1 - zoomed.t0).toBeCloseTo(D + 2 * bleed, 2);
    // Fully zoomed out fills the hard bleed window.
    expect(zoomed.t0).toBeCloseTo(-bleed, 2);
    expect(zoomed.t1).toBeCloseTo(D + bleed, 2);
  });
});

describe("panSoft", () => {
  it("pans 1:1 while the leading edge stays inside [0, duration]", () => {
    const vp: TimeViewport = { t0: 2e9, t1: 4e9 };
    expect(panSoft(vp, -1e9, D)).toEqual({ t0: 1e9, t1: 3e9 });
    expect(panSoft(vp, 1e9, D)).toEqual({ t0: 3e9, t1: 5e9 });
  });

  it("compresses the portion of a pan that pushes past a logical bound (~0.35)", () => {
    const vp: TimeViewport = { t0: 0.5e9, t1: 2.5e9 };
    const out = panSoft(vp, -1e9, D); // target t0 = -0.5e9, all excess past 0
    expect(out.t0).toBeCloseTo(-0.5e9 * 0.35, 3);
    expect(out.t1 - out.t0).toBeCloseTo(2e9, 3); // span preserved
  });

  it("never exceeds the hard bleed bound no matter how far you fling", () => {
    const vp: TimeViewport = { t0: 0.5e9, t1: 2.5e9 };
    const left = panSoft(vp, -1e12, D);
    expect(left.t0).toBeCloseTo(-bleed, 2);
    expect(left.t0).toBeGreaterThanOrEqual(-bleed - 1e-3);
    const right = panSoft({ t0: 7.5e9, t1: 9.5e9 }, 1e12, D);
    expect(right.t1).toBeCloseTo(D + bleed, 2);
  });
});

describe("settleTarget", () => {
  it("is identity when already legal", () => {
    const vp: TimeViewport = { t0: 2e9, t1: 6e9 };
    expect(settleTarget(vp, D)).toEqual(vp);
  });
  it("translates an out-of-bounds window back into [0, duration], span preserved", () => {
    const vp: TimeViewport = { t0: -bleed, t1: -bleed + 2e9 };
    const out = settleTarget(vp, D);
    expect(out.t0).toBe(0);
    expect(out.t1 - out.t0).toBeCloseTo(2e9, 6);
    const hi: TimeViewport = { t0: D + bleed - 2e9, t1: D + bleed };
    const outHi = settleTarget(hi, D);
    expect(outHi.t1).toBe(D);
    expect(outHi.t1 - outHi.t0).toBeCloseTo(2e9, 6);
  });
  it("centers on the recording when the span exceeds the duration", () => {
    const wide: TimeViewport = { t0: -bleed, t1: D + bleed }; // span > D
    const out = settleTarget(wide, D);
    const span = wide.t1 - wide.t0;
    expect((out.t0 + out.t1) / 2).toBeCloseTo(D / 2, 3);
    expect(out.t1 - out.t0).toBeCloseTo(span, 3);
  });
});

describe("nsAtX / fracOf", () => {
  const vp: TimeViewport = { t0: 1e9, t1: 5e9 };
  const L = 100;
  const W = 200;

  it("round-trips x → ns → frac (in-bounds)", () => {
    const ns = nsAtX(150, L, W, vp); // frac 0.25 → 2e9
    expect(ns).toBeCloseTo(2e9, 3);
    expect(fracOf(ns, vp)).toBeCloseTo(0.25, 6);
  });
  it("round-trips out-of-bounds (frac may exceed [0,1], unclamped)", () => {
    const ns = nsAtX(350, L, W, vp); // frac 1.25
    expect(fracOf(ns, vp)).toBeCloseTo(1.25, 6);
    const before = nsAtX(50, L, W, vp); // frac -0.25
    expect(fracOf(before, vp)).toBeCloseTo(-0.25, 6);
  });
  it("degenerate width → t0; degenerate span → frac 0", () => {
    expect(nsAtX(150, L, 0, vp)).toBe(vp.t0);
    expect(fracOf(2e9, { t0: 3e9, t1: 3e9 })).toBe(0);
  });
});

describe("rulerTicks", () => {
  const isNiceNs = (step: number): boolean => {
    const pow = Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
    const mant = Math.round(step / pow);
    return [1, 2, 5, 10].includes(mant);
  };

  it("uses nice 1/2/5·10^k steps at ~target density (≤ ~1.5× targetPx)", () => {
    for (const span of [1e9, 3e9, 7e9, 25e9, 4e6]) {
      const width = 1000;
      const target = 100;
      const ticks = rulerTicks({ t0: 0, t1: span }, width, target);
      expect(ticks.length).toBeGreaterThan(1);
      const step = ticks[1]!.ns - ticks[0]!.ns;
      expect(isNiceNs(step)).toBe(true);
      const spacingPx = (step * width) / span;
      expect(spacingPx).toBeLessThanOrEqual(target * 1.6);
      expect(spacingPx).toBeGreaterThanOrEqual(target * 0.6);
    }
  });

  it("labels major ticks and leaves minor ticks unlabeled", () => {
    const ticks = rulerTicks({ t0: 0, t1: D }, 1000, 100); // step 1e9, major 5e9
    const majors = ticks.filter((t) => t.major);
    expect(majors.every((t) => t.label !== null)).toBe(true);
    expect(ticks.filter((t) => !t.major).every((t) => t.label === null)).toBe(true);
    const five = ticks.find((t) => t.ns === 5e9);
    expect(five?.label).toBe("0:05");
  });

  it("covers the full viewport incl. bleed and labels negatives only at majors", () => {
    const ticks = rulerTicks({ t0: -6e9, t1: 4e9 }, 1000, 100); // step 1e9, major 5e9
    expect(ticks[0]!.ns).toBeLessThan(0); // reaches into the bleed
    const negMajor = ticks.find((t) => t.ns === -5e9);
    expect(negMajor?.major).toBe(true);
    expect(negMajor?.label).toBe("−0:05");
    const negMinor = ticks.find((t) => t.ns === -4e9);
    expect(negMinor?.major).toBe(false);
    expect(negMinor?.label).toBeNull();
  });

  it("adapts label precision to the step size", () => {
    // Fine zoom → sub-second steps → ms/us precision labels.
    const msTicks = rulerTicks({ t0: 0, t1: 20e6 }, 1000, 100); // ~2e6 step
    const labeled = msTicks.find((t) => t.label !== null && t.ns > 0);
    expect(labeled?.label).toMatch(/\d+:\d\d\.\d{3}|\d+\.\d{6}/);
  });
});

describe("interpolatePlayhead", () => {
  it("extrapolates by wall-clock · rate while playing", () => {
    // 100 ms elapsed at 1× → +100 ms = +1e8 ns.
    expect(interpolatePlayhead(1e9, 1000, 1100, 1, true, D)).toBeCloseTo(1.1e9, 3);
    // 2× rate doubles the advance.
    expect(interpolatePlayhead(1e9, 1000, 1100, 2, true, D)).toBeCloseTo(1.2e9, 3);
  });
  it("clamps to [0, duration]", () => {
    expect(interpolatePlayhead(D - 1e6, 1000, 5000, 1, true, D)).toBe(D);
    expect(interpolatePlayhead(1e6, 1000, 1100, -1, true, D)).toBe(0);
  });
  it("is identity when paused/scrubbing", () => {
    expect(interpolatePlayhead(3.2e9, 1000, 9999, 1, false, D)).toBe(3.2e9);
  });
});
