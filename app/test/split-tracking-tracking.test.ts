// Split-tracking PURE core (modules/split-tracking/tracking.ts): geometry, the
// per-eye visual-servo control law, and the single-side TrackResult reducer.
// All side-effect-free — synthetic inputs only (no addon, no controller). Idiom
// follows tracker-swap.test.ts / disparity-tracker-feed.test.ts (spy sinks pin
// routing) and drag-slew.test.ts (pure control-class simulation).

import { describe, expect, it, vi } from "vitest";
import type { Point2d, Rect } from "core/Geometry";
import {
  DEFAULT_TILE,
  MIN_TILE,
  MAX_TILE,
  DEFAULT_GAINS,
  DEFAULT_MAX_STEP_V,
  TRACKER_LOST_TOLERANCE,
  tileRect,
  applyJInv,
  EyeServo,
  reduceResult,
  type Mat2,
  type PidGains,
  type SideHandlers,
} from "@modules/split-tracking/tracking";

const IDENTITY: Mat2 = [1, 0, 0, 1];

// ---- constants ---------------------------------------------------------------

describe("split-tracking tunables", () => {
  it("exposes the pinned tile bounds", () => {
    expect(DEFAULT_TILE).toBe(512);
    expect(MIN_TILE).toBe(64);
    expect(MAX_TILE).toBe(1024);
    expect(MIN_TILE).toBeLessThan(DEFAULT_TILE);
    expect(DEFAULT_TILE).toBeLessThan(MAX_TILE);
  });

  it("DEFAULT_GAINS are safe & conservative (small, non-negative)", () => {
    expect(DEFAULT_GAINS.kp).toBeGreaterThan(0);
    expect(DEFAULT_GAINS.kp).toBeLessThanOrEqual(1); // gentle P
    expect(DEFAULT_GAINS.ki).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_GAINS.ki).toBeLessThan(DEFAULT_GAINS.kp); // tiny I
    expect(DEFAULT_GAINS.kd).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_GAINS.kd).toBeLessThan(DEFAULT_GAINS.kp); // small D
  });

  it("miss tolerance matches disparity-scope (10) and max-step is positive", () => {
    expect(TRACKER_LOST_TOLERANCE).toBe(10);
    expect(DEFAULT_MAX_STEP_V).toBeGreaterThan(0);
  });
});

// ---- tileRect ----------------------------------------------------------------

const FRAME = { width: 1920, height: 1080 };
const TILE = { w: 512, h: 512 };

function assertInside(r: Rect, frame: { width: number; height: number }) {
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.width).toBeLessThanOrEqual(frame.width);
  expect(r.y + r.height).toBeLessThanOrEqual(frame.height);
}

describe("tileRect", () => {
  it("centers a fully-interior tile on the target", () => {
    const r = tileRect({ x: 960, y: 540 }, TILE, FRAME);
    expect(r).toEqual({ x: 704, y: 284, width: 512, height: 512 });
    assertInside(r, FRAME);
  });

  it("shifts (not shrinks) at the LEFT edge", () => {
    const r = tileRect({ x: 10, y: 540 }, TILE, FRAME);
    expect(r).toEqual({ x: 0, y: 284, width: 512, height: 512 });
    assertInside(r, FRAME);
  });

  it("shifts (not shrinks) at the RIGHT edge", () => {
    const r = tileRect({ x: 1900, y: 540 }, TILE, FRAME);
    expect(r).toEqual({ x: 1920 - 512, y: 284, width: 512, height: 512 });
    assertInside(r, FRAME);
  });

  it("shifts (not shrinks) at the TOP edge", () => {
    const r = tileRect({ x: 960, y: 10 }, TILE, FRAME);
    expect(r).toEqual({ x: 704, y: 0, width: 512, height: 512 });
    assertInside(r, FRAME);
  });

  it("shifts (not shrinks) at the BOTTOM edge", () => {
    const r = tileRect({ x: 960, y: 1070 }, TILE, FRAME);
    expect(r).toEqual({ x: 704, y: 1080 - 512, width: 512, height: 512 });
    assertInside(r, FRAME);
  });

  it("clamps an OVERSIZE tile to the frame and centers it (origin 0)", () => {
    const small = { width: 400, height: 300 };
    const r = tileRect({ x: 999, y: -50 }, { w: 512, h: 512 }, small);
    expect(r).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    assertInside(r, small);
  });

  it("rounds to integer pixels for fractional centers/tiles", () => {
    const r = tileRect({ x: 960.4, y: 540.6 }, { w: 513, h: 511 }, FRAME);
    for (const v of [r.x, r.y, r.width, r.height]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    assertInside(r, FRAME);
  });
});

// ---- applyJInv ---------------------------------------------------------------

describe("applyJInv", () => {
  it("identity passes the error through", () => {
    expect(applyJInv({ x: 3, y: -7 }, IDENTITY)).toEqual({ x: 3, y: -7 });
  });

  it("applies a 90° rotation ([[0,-1],[1,0]])", () => {
    expect(applyJInv({ x: 1, y: 0 }, [0, -1, 1, 0])).toEqual({ x: 0, y: 1 });
  });

  it("applies a per-axis scale ([[2,0],[0,3]])", () => {
    expect(applyJInv({ x: 5, y: 7 }, [2, 0, 0, 3])).toEqual({ x: 10, y: 21 });
  });

  it("row-major: [[a,b],[c,d]]·(x,y) = (ax+by, cx+dy)", () => {
    expect(applyJInv({ x: 1, y: 1 }, [1, 2, 3, 4])).toEqual({ x: 3, y: 7 });
  });
});

// ---- EyeServo ----------------------------------------------------------------

describe("EyeServo", () => {
  it("converges toward zero error on the integrating mirror plant (identity jInv)", () => {
    // Plant model: accumulated volt is the mirror pose; with identity jInv a
    // px error IS a volt error, so `volt += delta` closes the loop each tick.
    // The servo is dt-agnostic (gains are per-tick), so feed one tick per
    // iteration (dt = 1). A stable servo drives the residual error to ~0.
    const servo = new EyeServo(DEFAULT_GAINS, 100); // wide clamp: isolate the PID
    const goal = { x: 80, y: -60 };
    const volt = { x: 0, y: 0 };
    for (let i = 0; i < 600; i++) {
      const errPx = { x: goal.x - volt.x, y: goal.y - volt.y };
      const d = servo.step(errPx, IDENTITY, 1);
      volt.x += d.x;
      volt.y += d.y;
    }
    expect(volt.x).toBeCloseTo(goal.x, 3);
    expect(volt.y).toBeCloseTo(goal.y, 3);
  });

  it("monotonically reduces the error magnitude while converging (P-only)", () => {
    // Pure-P on the integrating plant: err decays by (1-kp) each tick — a
    // strictly monotonic contraction, the cleanest convergence witness.
    const servo = new EyeServo({ kp: 0.15, ki: 0, kd: 0 }, 100);
    const goal = 50;
    let v = 0;
    let prevAbsErr = Math.abs(goal - v);
    for (let i = 0; i < 200; i++) {
      const d = servo.step({ x: goal - v, y: 0 }, IDENTITY, 1);
      v += d.x;
      const absErr = Math.abs(goal - v);
      expect(absErr).toBeLessThanOrEqual(prevAbsErr + 1e-9); // never diverges
      prevAbsErr = absErr;
    }
    expect(prevAbsErr).toBeLessThan(0.5);
  });

  it("clamps each axis to ±maxStepV on a large error", () => {
    const servo = new EyeServo(DEFAULT_GAINS, 0.5);
    const d = servo.step({ x: 100000, y: -100000 }, IDENTITY, 1 / 60);
    expect(d.x).toBeCloseTo(0.5, 10);
    expect(d.y).toBeCloseTo(-0.5, 10);
    expect(Math.abs(d.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(d.y)).toBeLessThanOrEqual(0.5);
  });

  it("anti-windup: a saturating run does not overshoot when the error clears", () => {
    const gains: PidGains = { kp: 0.5, ki: 0.5, kd: 0 };
    const servo = new EyeServo(gains, 1);
    // 30 ticks of a huge error — the step saturates at +1 the whole time; a
    // naive integrator would wind up enormously.
    for (let i = 0; i < 30; i++) {
      const d = servo.step({ x: 100, y: 0 }, IDENTITY, 1);
      expect(d.x).toBeCloseTo(1, 10); // pinned at the clamp
    }
    // Error clears: the frozen integrator must NOT keep driving the mirror.
    const cleared = servo.step({ x: 0, y: 0 }, IDENTITY, 1);
    expect(Math.abs(cleared.x)).toBeLessThan(0.05); // no wound-up overshoot
  });

  it("reset() zeroes the integrator + last-error (fresh == post-reset)", () => {
    const servo = new EyeServo(DEFAULT_GAINS, 100);
    // Accumulate integrator/derivative state.
    for (let i = 0; i < 10; i++) servo.step({ x: 25, y: -15 }, IDENTITY, 1 / 60);
    servo.reset();

    const fresh = new EyeServo(DEFAULT_GAINS, 100);
    const errPx = { x: 12, y: -8 };
    const a = servo.step(errPx, IDENTITY, 1 / 60);
    const b = fresh.step(errPx, IDENTITY, 1 / 60);
    expect(a.x).toBeCloseTo(b.x, 12);
    expect(a.y).toBeCloseTo(b.y, 12);
  });

  it("dtSec = 0 is safe: P-only, finite, touches no state", () => {
    const gains: PidGains = { kp: 0.2, ki: 0.5, kd: 0.9 };
    const servo = new EyeServo(gains, 100);
    const d0 = servo.step({ x: 10, y: -4 }, IDENTITY, 0);
    expect(d0.x).toBeCloseTo(0.2 * 10, 10); // kp·e, no I/D contribution
    expect(d0.y).toBeCloseTo(0.2 * -4, 10);
    expect(Number.isFinite(d0.x)).toBe(true);
    expect(Number.isFinite(d0.y)).toBe(true);
    // A follow-up dt>0 tick behaves like the first real tick (no state moved).
    const fresh = new EyeServo(gains, 100);
    const a = servo.step({ x: 10, y: -4 }, IDENTITY, 1 / 60);
    const b = fresh.step({ x: 10, y: -4 }, IDENTITY, 1 / 60);
    expect(a.x).toBeCloseTo(b.x, 12);
    expect(a.y).toBeCloseTo(b.y, 12);
  });

  it("setGains changes the applied control law", () => {
    const servo = new EyeServo({ kp: 0.1, ki: 0, kd: 0 }, 100);
    expect(servo.step({ x: 10, y: 0 }, IDENTITY, 0).x).toBeCloseTo(1, 10);
    servo.setGains({ kp: 0.3, ki: 0, kd: 0 });
    expect(servo.step({ x: 10, y: 0 }, IDENTITY, 0).x).toBeCloseTo(3, 10);
  });

  it("maps px error through jInv before the PID (volt-space control)", () => {
    const servo = new EyeServo({ kp: 1, ki: 0, kd: 0 }, 1000);
    // jInv scales x by 2, y by 3; P-only (dt=0) → delta = kp·(jInv·errPx).
    const d = servo.step({ x: 5, y: 7 }, [2, 0, 0, 3], 0);
    expect(d.x).toBeCloseTo(10, 10);
    expect(d.y).toBeCloseTo(21, 10);
  });
});

// ---- reduceResult ------------------------------------------------------------

function sinks() {
  return {
    onTrack: vi.fn<[Point2d, Rect], void>(),
    onDrag: vi.fn<[Point2d], void>(),
    onLost: vi.fn<[], void>(),
  } satisfies SideHandlers;
}

const bbox: Rect = { x: 0, y: 0, width: 10, height: 10 };

describe("reduceResult (single-side routing)", () => {
  it("OVERRIDDEN → onDrag(center), resets misses to 0 (bypasses armed gate)", () => {
    const h = sinks();
    const n = reduceResult(
      { overridden: true, found: false, center: { x: 7, y: 8 }, bbox: null },
      false, // even un-armed, a drag drives onDrag
      5,
      h,
    );
    expect(h.onDrag).toHaveBeenCalledWith({ x: 7, y: 8 });
    expect(h.onTrack).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("armed & found → onTrack(center,bbox), resets misses to 0", () => {
    const h = sinks();
    const n = reduceResult(
      { overridden: false, found: true, center: { x: 3, y: 4 }, bbox },
      true,
      4,
      h,
    );
    expect(h.onTrack).toHaveBeenCalledWith({ x: 3, y: 4 }, bbox);
    expect(h.onLost).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("armed & miss → increments; fires onLost EXACTLY at the threshold", () => {
    const h = sinks();
    const miss = { overridden: false, found: false, center: null, bbox: null };

    // one below the threshold: increments, no onLost
    const below = reduceResult(miss, true, TRACKER_LOST_TOLERANCE - 2, h);
    expect(below).toBe(TRACKER_LOST_TOLERANCE - 1);
    expect(h.onLost).not.toHaveBeenCalled();

    // reaching the threshold: fires onLost once, returns the threshold
    const at = reduceResult(miss, true, TRACKER_LOST_TOLERANCE - 1, h);
    expect(at).toBe(TRACKER_LOST_TOLERANCE);
    expect(h.onLost).toHaveBeenCalledTimes(1);
  });

  it("!armed → ignores everything, misses UNCHANGED", () => {
    const h = sinks();
    const n = reduceResult(
      { overridden: false, found: true, center: { x: 1, y: 2 }, bbox },
      false,
      7,
      h,
    );
    expect(h.onTrack).not.toHaveBeenCalled();
    expect(h.onLost).not.toHaveBeenCalled();
    expect(n).toBe(7);
  });

  it("null-guards: overridden w/ null center does NOT call onDrag (still resets)", () => {
    const h = sinks();
    const n = reduceResult(
      { overridden: true, found: false, center: null, bbox: null },
      true,
      3,
      h,
    );
    expect(h.onDrag).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it("null-guards: armed found w/ missing center/bbox counts as a miss", () => {
    const h = sinks();
    const noCenter = reduceResult(
      { overridden: false, found: true, center: null, bbox },
      true,
      0,
      h,
    );
    expect(h.onTrack).not.toHaveBeenCalled();
    expect(noCenter).toBe(1);

    const noBbox = reduceResult(
      { overridden: false, found: true, center: { x: 1, y: 1 }, bbox: null },
      true,
      0,
      h,
    );
    expect(h.onTrack).not.toHaveBeenCalled();
    expect(noBbox).toBe(1);
  });

  it("threshold streak: TRACKER_LOST_TOLERANCE consecutive armed misses reach lost", () => {
    const h = sinks();
    const miss = { overridden: false, found: false, center: null, bbox: null };
    let misses = 0;
    for (let i = 0; i < TRACKER_LOST_TOLERANCE; i++) {
      misses = reduceResult(miss, true, misses, h);
    }
    expect(misses).toBe(TRACKER_LOST_TOLERANCE);
    expect(h.onLost).toHaveBeenCalledTimes(1);
  });
});
