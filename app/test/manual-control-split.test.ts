// Manual-control "split fovea" precedence — the pure per-eye override rule
// (app/modules/manual-control/split.ts). Covers: override wins over the unified
// solution, an un-dragged eye holds the shared command, reunify clears both,
// and the UI flags. The session wires these into `targetVolts()` (resolve),
// `steer`/set-point (reunify), and `splitEye` (set) — verified here in isolation
// since the session logic lives in a resource-scoped closure.

import { describe, expect, it } from "vitest";
import {
  unifiedSplit,
  resolveVolts,
  splitFlags,
  isSplit,
  type SplitVolts,
} from "@modules/manual-control/split";

const pos = (x: number, y: number) => ({ x, y });
const unified = { l: pos(1, 2), r: pos(3, 4) };

describe("manual-control split fovea", () => {
  it("starts unified (both eyes follow the shared solution)", () => {
    const split = unifiedSplit();
    expect(split).toEqual({ l: null, r: null });
    expect(isSplit(split)).toBe(false);
    expect(splitFlags(split)).toEqual({ l: false, r: false });
    expect(resolveVolts(unified, split)).toEqual(unified);
  });

  it("drag L: L follows the override, R holds the unified command", () => {
    const split: SplitVolts = { l: pos(50, 60), r: null };
    const out = resolveVolts(unified, split);
    expect(out.l).toEqual(pos(50, 60)); // override wins
    expect(out.r).toEqual(unified.r); // other eye holds
    expect(splitFlags(split)).toEqual({ l: true, r: false });
    expect(isSplit(split)).toBe(true);
  });

  it("drag R independently: both eyes can be overridden at once", () => {
    const split: SplitVolts = { l: pos(50, 60), r: pos(-7, -8) };
    const out = resolveVolts(unified, split);
    expect(out).toEqual({ l: pos(50, 60), r: pos(-7, -8) });
    expect(splitFlags(split)).toEqual({ l: true, r: true });
  });

  it("override precedence: split wins even as the unified solution moves", () => {
    const split: SplitVolts = { l: pos(50, 60), r: null };
    const moved = { l: pos(9, 9), r: pos(11, 11) };
    const out = resolveVolts(moved, split);
    expect(out.l).toEqual(pos(50, 60)); // pinned, ignores the moved unified L
    expect(out.r).toEqual(moved.r); // un-pinned eye tracks the new unified R
  });

  it("reunify clears both overrides (a steer / set-point)", () => {
    const split: SplitVolts = { l: pos(50, 60), r: pos(-7, -8) };
    // reunify == restore the unified state
    const reunified = unifiedSplit();
    Object.assign(split, reunified);
    expect(resolveVolts(unified, split)).toEqual(unified);
    expect(isSplit(split)).toBe(false);
  });
});
