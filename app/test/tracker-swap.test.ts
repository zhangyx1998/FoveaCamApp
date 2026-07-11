// The pure tracker hot-swap sequencing (disparity-scope/tracker-swap.ts —
// runtime-selectable drop-in tracker engines, user 2026-07-11). All side
// effects are injected ops, so plain spies pin the ORDER (release before
// create, consume before rearm), the arm-only-if-armed gate, and the degrade
// ladder (requested throws → fallback runs + ok:false; both throw → null).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACKER_TYPE,
  swapTracker,
  type SwapTrackerOps,
  type TrackerType,
} from "../modules/disparity-scope/tracker-swap";

/** Spy op set recording call order; `failFor` types throw at create. */
function spyOps(failFor: TrackerType[] = []) {
  const calls: string[] = [];
  const ops: SwapTrackerOps<string> = {
    release: (t) => calls.push(`release:${t}`),
    create: (type) => {
      calls.push(`create:${type}`);
      if (failFor.includes(type)) throw new Error(`no brick for ${type}`);
      return `tracker-${type}`;
    },
    consume: (t) => calls.push(`consume:${t}`),
    rearm: (t) => calls.push(`rearm:${t}`),
  };
  return { calls, ops };
}

describe("tracker hot-swap sequencing", () => {
  it("defaults to the hybrid engine (current behavior)", () => {
    expect(DEFAULT_TRACKER_TYPE).toBe("hybrid");
  });

  it("releases the old tracker BEFORE creating, consumes BEFORE re-arming", () => {
    const { calls, ops } = spyOps();
    const res = swapTracker("tracker-hybrid", "kcf", "hybrid", true, ops);
    expect(calls).toEqual([
      "release:tracker-hybrid",
      "create:kcf",
      "consume:tracker-kcf",
      "rearm:tracker-kcf",
    ]);
    expect(res).toEqual({ tracker: "tracker-kcf", type: "kcf", ok: true });
  });

  it("re-arms ONLY when the auto-follow gate was armed", () => {
    const { calls, ops } = spyOps();
    swapTracker("tracker-hybrid", "kcf", "hybrid", false, ops);
    expect(calls).not.toContain("rearm:tracker-kcf");
    expect(calls).toContain("consume:tracker-kcf");
  });

  it("first activation (no old tracker) skips release", () => {
    const { calls, ops } = spyOps();
    const res = swapTracker(null, "hybrid", "hybrid", false, ops);
    expect(calls).toEqual(["create:hybrid", "consume:tracker-hybrid"]);
    expect(res.ok).toBe(true);
  });

  it("degrades to the previously-running type when the requested factory throws", () => {
    const { calls, ops } = spyOps(["kcf"]);
    const res = swapTracker("tracker-hybrid", "kcf", "hybrid", true, ops);
    // The fallback keeps a tracker running; the caller pins state to reality.
    expect(res).toEqual({ tracker: "tracker-hybrid", type: "hybrid", ok: false });
    expect(calls).toEqual([
      "release:tracker-hybrid",
      "create:kcf",
      "create:hybrid",
      "consume:tracker-hybrid",
      "rearm:tracker-hybrid",
    ]);
  });

  it("returns a null tracker when BOTH factories throw (pointer-only degrade)", () => {
    const { calls, ops } = spyOps(["kcf", "hybrid"]);
    const res = swapTracker("tracker-hybrid", "kcf", "hybrid", true, ops);
    expect(res.tracker).toBeNull();
    expect(res.ok).toBe(false);
    expect(calls).not.toContain("consume:tracker-kcf");
    expect(calls.filter((c) => c.startsWith("rearm"))).toEqual([]);
  });

  it("re-selecting the running type (fallback === requested) does not double-create", () => {
    const { calls, ops } = spyOps(["hybrid"]);
    const res = swapTracker("tracker-hybrid", "hybrid", "hybrid", false, ops);
    expect(res.tracker).toBeNull(); // single create attempt, no bogus retry
    expect(calls.filter((c) => c.startsWith("create"))).toEqual(["create:hybrid"]);
  });
});
