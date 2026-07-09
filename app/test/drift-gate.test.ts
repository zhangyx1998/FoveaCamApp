// Coverage for the pure calibrate-drift gating/threshold helpers (proposal
// findings 1 + 7): per-eye fovea-lock gate, derived-vs-saved delta, and the
// Update-button noise floor. No native tracker — fakes satisfy the structural
// `LockState`.

import { describe, expect, it } from "vitest";
import {
  gateOnLock,
  driftDelta,
  driftUpdatable,
  DRIFT_NOISE_FLOOR_RAD,
  type LockState,
} from "@modules/calibrate-drift/drift-gate";
import type { Point2d } from "core/Geometry";

const locked: LockState = { target: { img_pts: [] } };
const unlocked: LockState = { target: null };

describe("drift-gate.gateOnLock", () => {
  it("passes the value through when the tracker holds a target", () => {
    const v: Point2d = { x: 1, y: 2 };
    expect(gateOnLock(v, locked)).toBe(v);
  });

  it("nulls the value when the tracker has no target", () => {
    expect(gateOnLock({ x: 1, y: 2 }, unlocked)).toBeNull();
  });

  it("nulls the value when the tracker is missing (pre-activation)", () => {
    expect(gateOnLock({ x: 1, y: 2 }, null)).toBeNull();
    expect(gateOnLock({ x: 1, y: 2 }, undefined)).toBeNull();
  });

  it("nulls a null value regardless of lock", () => {
    expect(gateOnLock(null, locked)).toBeNull();
  });
});

describe("drift-gate.driftDelta", () => {
  it("is null with no derived value", () => {
    expect(driftDelta(null, { x: 1, y: 1 })).toBeNull();
  });

  it("treats a missing saved drift as the origin", () => {
    expect(driftDelta({ x: 3, y: 4 }, null)).toBeCloseTo(5);
  });

  it("is the euclidean magnitude of derived minus saved", () => {
    expect(driftDelta({ x: 4, y: 6 }, { x: 1, y: 2 })).toBeCloseTo(5);
  });
});

describe("drift-gate.driftUpdatable", () => {
  it("is false with no derived value (unlocked eye)", () => {
    expect(driftUpdatable(null, { x: 0, y: 0 })).toBe(false);
  });

  it("is false when derived is within the noise floor of saved", () => {
    const saved: Point2d = { x: 0.01, y: 0.01 };
    const derived: Point2d = { x: saved.x + DRIFT_NOISE_FLOOR_RAD / 2, y: saved.y };
    expect(driftUpdatable(derived, saved)).toBe(false);
  });

  it("is true once the delta clears the noise floor", () => {
    const saved: Point2d = { x: 0.01, y: 0.01 };
    const derived: Point2d = { x: saved.x + DRIFT_NOISE_FLOOR_RAD * 2, y: saved.y };
    expect(driftUpdatable(derived, saved)).toBe(true);
  });

  it("is true for a first, unsaved measurement above the floor", () => {
    expect(driftUpdatable({ x: DRIFT_NOISE_FLOOR_RAD * 3, y: 0 }, null)).toBe(true);
  });
});
