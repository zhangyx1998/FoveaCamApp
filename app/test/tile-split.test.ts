// Viewer tile-split math (viewer-tiles-split-and-project.md ruling 3): the pure
// fraction transforms behind the full-width, divider-resizable tiles row —
// equal split, reconcile-to-count (drop/append + renorm), and divider drag with
// both neighbors clamped at the floor. Invariant under test: length === n and
// the list sums to 1.

import { describe, expect, it } from "vitest";
import {
  MIN_TILE_FRACTION,
  equalFractions,
  reconcileFractions,
  resizeAtDivider,
} from "@src/viewer/tile-split";

const sum = (fr: readonly number[]): number => fr.reduce((a, b) => a + b, 0);
const approx = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

describe("equalFractions", () => {
  it("splits n tiles evenly, summing to 1", () => {
    expect(equalFractions(4)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(approx(sum(equalFractions(7)), 1)).toBe(true);
    expect(equalFractions(7).every((f) => approx(f, 1 / 7))).toBe(true);
  });
  it("degenerate counts: n<=0 → [], n===1 → [1]", () => {
    expect(equalFractions(0)).toEqual([]);
    expect(equalFractions(-3)).toEqual([]);
    expect(equalFractions(1)).toEqual([1]);
    expect(equalFractions(Number.NaN)).toEqual([]);
  });
});

describe("reconcileFractions", () => {
  it("identity when the list is already valid (right length, positive, sums to 1)", () => {
    const fr = [0.2, 0.3, 0.5];
    const out = reconcileFractions(fr, 3);
    expect(out).toEqual(fr);
    expect(out).not.toBe(fr); // a fresh array
  });
  it("absent / garbage → an equal split", () => {
    expect(reconcileFractions(undefined, 3).every((f) => approx(f, 1 / 3))).toBe(true);
    expect(reconcileFractions([], 4).every((f) => approx(f, 0.25))).toBe(true);
  });
  it("renormalizes a list that does not sum to 1", () => {
    const out = reconcileFractions([2, 2], 2); // weights, not fractions
    expect(out).toEqual([0.5, 0.5]);
    expect(approx(sum(out), 1)).toBe(true);
  });
  it("drops extras when the count shrank (renormalizing the remainder)", () => {
    const out = reconcileFractions([0.25, 0.25, 0.25, 0.25], 2);
    expect(out.length).toBe(2);
    expect(approx(sum(out), 1)).toBe(true);
    expect(out.every((f) => approx(f, 0.5))).toBe(true);
  });
  it("appends shares when the count grew (renormalizing the whole)", () => {
    const out = reconcileFractions([0.5, 0.5], 3);
    expect(out.length).toBe(3);
    expect(approx(sum(out), 1)).toBe(true);
    expect(out.every((f) => approx(f, 1 / 3))).toBe(true);
  });
  it("lifts a below-floor entry to the floor and re-settles the rest (sum 1)", () => {
    const out = reconcileFractions([0.97, 0.02, 0.01], 3);
    expect(out.length).toBe(3);
    expect(approx(sum(out), 1)).toBe(true);
    expect(out.every((f) => f >= MIN_TILE_FRACTION - 1e-9)).toBe(true);
  });
  it("degenerate n: n<=0 → [], n===1 → [1]", () => {
    expect(reconcileFractions([0.3, 0.7], 0)).toEqual([]);
    expect(reconcileFractions([0.3, 0.7], 1)).toEqual([1]);
    expect(reconcileFractions(undefined, 1)).toEqual([1]);
  });
});

describe("resizeAtDivider", () => {
  it("moves the shared edge, leaving other tiles untouched and the sum at 1", () => {
    const fr = [0.25, 0.25, 0.25, 0.25];
    const out = resizeAtDivider(fr, 1, 0.1);
    expect(out).toEqual([0.25, 0.35, 0.15, 0.25]);
    expect(approx(sum(out), 1)).toBe(true);
    expect(out).not.toBe(fr); // fresh array, input unmutated
    expect(fr).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
  it("clamps so the shrinking (right) neighbor cannot drop below the floor", () => {
    const fr = [0.5, 0.5];
    const out = resizeAtDivider(fr, 0, 0.9); // would drive tile 1 negative
    expect(approx(out[1]!, MIN_TILE_FRACTION)).toBe(true);
    expect(approx(sum(out), 1)).toBe(true);
  });
  it("clamps so the shrinking (left) neighbor cannot drop below the floor", () => {
    const fr = [0.5, 0.5];
    const out = resizeAtDivider(fr, 0, -0.9); // would drive tile 0 negative
    expect(approx(out[0]!, MIN_TILE_FRACTION)).toBe(true);
    expect(approx(sum(out), 1)).toBe(true);
  });
  it("out-of-range divider index or bad delta → an unchanged copy", () => {
    const fr = [0.3, 0.3, 0.4];
    expect(resizeAtDivider(fr, -1, 0.1)).toEqual(fr);
    expect(resizeAtDivider(fr, 2, 0.1)).toEqual(fr); // last tile has no right edge
    expect(resizeAtDivider(fr, 0, Number.NaN)).toEqual(fr);
    expect(resizeAtDivider(fr, 0, 0.1)).not.toBe(fr);
  });
});
