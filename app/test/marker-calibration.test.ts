// Unit coverage for the shared marker-calibration primitives used by
// calibrate-extrinsic / calibrate-drift / calibrate-distortion. The two native
// value imports (`MarkerTracker`, `MarkerDetector`) are mocked so importing the
// module doesn't pull the addon — the primitives under test are pure and run
// against structural fake trackers (`createTrackerTriple` itself just wires
// those natives together and isn't exercised here).

import { describe, expect, it, vi } from "vitest";

vi.mock("core/Vision", () => ({ MarkerDetector: class {} }));
vi.mock("@orchestrator/marker-tracker", () => ({ MarkerTracker: class {} }));

import {
  bindDetections,
  detectionView,
  detectionViews,
  retarget,
  stopTriple,
  type Role,
  type Tracker,
} from "@orchestrator/marker-calibration";
import type { Point2d } from "core/Geometry";

type FakeTracker = Tracker & {
  handlers: Set<() => void>;
  stopped: boolean;
};

function fakeTracker(target: { img_pts: Point2d[] } | null = null): FakeTracker {
  const handlers = new Set<() => void>();
  return {
    targetId: 0,
    target,
    stopped: false,
    handlers,
    onDetection(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    stop() {
      this.stopped = true;
    },
  };
}

const pts = (n: number): Point2d[] => [{ x: n, y: n }];
const triple = (
  L = fakeTracker(),
  C = fakeTracker(),
  R = fakeTracker(),
): Record<Role, FakeTracker> => ({ L, C, R });

describe("marker-calibration primitives", () => {
  it("detectionView reflects the tracker's current target", () => {
    expect(detectionView(fakeTracker())).toBeNull();
    expect(detectionView(fakeTracker({ img_pts: pts(3) }))).toEqual({ points: pts(3) });
  });

  it("detectionViews maps all three roles", () => {
    const t = triple(fakeTracker({ img_pts: pts(1) }), fakeTracker(), fakeTracker({ img_pts: pts(2) }));
    expect(detectionViews(t)).toEqual({ L: { points: pts(1) }, C: null, R: { points: pts(2) } });
  });

  it("bindDetections subscribes the same handler to L/C/R and is disposable", () => {
    const t = triple();
    const disposers: Array<() => void> = [];
    const on = vi.fn();
    bindDetections(t, disposers, on);
    expect(disposers).toHaveLength(3);
    for (const r of ["L", "C", "R"] as const) expect(t[r].handlers.has(on)).toBe(true);
    for (const d of disposers) d();
    for (const r of ["L", "C", "R"] as const) expect(t[r].handlers.size).toBe(0);
  });

  it("bindDetections routes the wide (C) tracker through onCenter when given", () => {
    const t = triple();
    const on = vi.fn();
    const onCenter = vi.fn();
    bindDetections(t, [], on, onCenter);
    expect(t.L.handlers.has(on)).toBe(true);
    expect(t.R.handlers.has(on)).toBe(true);
    expect(t.C.handlers.has(onCenter)).toBe(true);
    expect(t.C.handlers.has(on)).toBe(false);
  });

  it("stopTriple stops every tracker and returns null (null-safe)", () => {
    const t = triple();
    expect(stopTriple(t)).toBeNull();
    expect([t.L.stopped, t.C.stopped, t.R.stopped]).toEqual([true, true, true]);
    expect(stopTriple(null)).toBeNull();
  });

  it("retarget updates one live tracker and is a no-op when cleared", () => {
    const t = triple();
    retarget(t, "R", 7);
    expect(t.R.targetId).toBe(7);
    expect(t.L.targetId).toBe(0);
    expect(() => retarget(null, "L", 1)).not.toThrow();
  });
});
