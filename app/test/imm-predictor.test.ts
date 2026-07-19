// IMM motion predictor chained after the disparity-scope tracker.
// The predictor consumes timestamped
// `TrackResult`s and outputs the target's ESTIMATED position at
// `t_result + delayMs` (positive = lead / future, negative = lag / past);
// `delayMs === 0` is an EXACT passthrough. Pure module (types-only core
// imports) — no native addon loads here.

import { describe, expect, it } from "vitest";
import { ImmPredictor, delayIsActive } from "@lib/imm-predictor";
import type { TrackResult } from "core/Tracker";
import type { Point2d, Rect } from "core/Geometry";

const FPS = 60;
const FRAME_NS = BigInt(Math.round(1e9 / FPS));
const T0 = 1_000_000_000n; // arbitrary non-zero device-clock base (ns)

function result(
  seq: number,
  over: {
    found?: boolean;
    overridden?: boolean;
    center?: Point2d | null;
    bbox?: Rect | null;
    ts?: bigint;
  } = {},
): TrackResult {
  const center = over.center === undefined ? { x: 0, y: 0 } : over.center;
  const bbox =
    over.bbox === undefined
      ? center
        ? { x: center.x - 5, y: center.y - 5, width: 10, height: 10 }
        : null
      : over.bbox;
  return {
    found: over.found ?? true,
    overridden: over.overridden ?? false,
    center,
    bbox,
    seq,
    deviceTimestamp: over.ts ?? T0 + FRAME_NS * BigInt(seq),
  };
}

/** Feed a constant-velocity trajectory (px/s) for `frames` samples at 60 Hz;
 *  return the last input measurement + the predictor's last output. */
function feedCV(
  pred: ImmPredictor,
  vx: number,
  vy: number,
  frames: number,
  startSeq = 0,
): { last: TrackResult; out: TrackResult } {
  let last!: TrackResult;
  let out!: TrackResult;
  for (let i = 0; i < frames; i++) {
    const seq = startSeq + i;
    const t = Number(FRAME_NS * BigInt(seq)) / 1e9;
    last = result(seq, { center: { x: vx * t, y: vy * t } });
    out = pred.process(last);
  }
  return { last, out };
}

describe("ImmPredictor — passthrough (delay = 0)", () => {
  it("returns the SAME object unchanged (exact passthrough, not a filtered copy)", () => {
    const pred = new ImmPredictor({ delayMs: 0 });
    const r = result(0, { center: { x: 3, y: 4 } });
    expect(pred.process(r)).toBe(r); // reference-identical
    const r2 = result(1, { center: { x: 9, y: 9 } });
    expect(pred.process(r2)).toBe(r2);
  });

  it("delayIsActive() gates node construction on a non-zero finite delay", () => {
    expect(delayIsActive(0)).toBe(false);
    expect(delayIsActive(undefined)).toBe(false);
    expect(delayIsActive(null)).toBe(false);
    expect(delayIsActive(NaN)).toBe(false);
    expect(delayIsActive(12)).toBe(true);
    expect(delayIsActive(-8)).toBe(true);
  });
});

describe("ImmPredictor — constant-velocity lead / lag", () => {
  it("leads a CV target by ≈ v·Δ with a positive delay", () => {
    const delayMs = 50;
    const pred = new ImmPredictor({ delayMs });
    const vx = 120; // px/s
    const { last, out } = feedCV(pred, vx, 0, 40);
    const shift = out.center!.x - last.center!.x;
    // Expected lead = v·Δ = 120 * 0.05 = 6 px.
    expect(shift).toBeCloseTo(vx * (delayMs / 1000), 0); // ±0.5 px
    expect(out.center!.y).toBeCloseTo(last.center!.y, 1);
  });

  it("lags a CV target by ≈ v·Δ with a negative delay (retrodiction)", () => {
    const delayMs = -50;
    const pred = new ImmPredictor({ delayMs });
    const vx = 120;
    const { last, out } = feedCV(pred, vx, 0, 40);
    const shift = out.center!.x - last.center!.x;
    expect(shift).toBeCloseTo(vx * (delayMs / 1000), 0); // negative ≈ -6 px
    expect(shift).toBeLessThan(0);
  });

  it("shifts the bbox by the SAME delta, size preserved; passes seq/ts/flags", () => {
    const pred = new ImmPredictor({ delayMs: 40 });
    feedCV(pred, 90, 0, 30);
    const last = result(30, { center: { x: 90 * (Number(FRAME_NS * 30n) / 1e9), y: 0 } });
    const out = pred.process(last);
    const shiftX = out.center!.x - last.center!.x;
    expect(out.bbox!.x - last.bbox!.x).toBeCloseTo(shiftX, 6);
    expect(out.bbox!.width).toBe(last.bbox!.width);
    expect(out.bbox!.height).toBe(last.bbox!.height);
    expect(out.seq).toBe(last.seq);
    expect(out.deviceTimestamp).toBe(last.deviceTimestamp);
    expect(out.found).toBe(true);
    expect(out.overridden).toBe(false);
  });

  it("first result passes through unchanged (no velocity known yet)", () => {
    const pred = new ImmPredictor({ delayMs: 50 });
    const r = result(0, { center: { x: 10, y: 10 } });
    expect(pred.process(r)).toBe(r);
  });
});

describe("ImmPredictor — abrupt stop (IMM beats a pure-CA filter)", () => {
  it("decays the post-stop overshoot faster than a CA-only filter", () => {
    const delayMs = 100; // a big lead exaggerates any residual velocity
    const imm = new ImmPredictor({ delayMs });
    const ca = new ImmPredictor({ delayMs, models: ["ca"] });
    const vx = 200; // px/s until the stop

    // Ramp both on the SAME CV trajectory.
    const rampFrames = 40;
    feedCV(imm, vx, 0, rampFrames);
    feedCV(ca, vx, 0, rampFrames);

    // Target STOPS: hold the last position for the rest.
    const stopX = vx * (Number(FRAME_NS * BigInt(rampFrames - 1)) / 1e9);
    const overshoot = (pred: ImmPredictor, framesAfter: number): number[] => {
      const errs: number[] = [];
      for (let i = 0; i < framesAfter; i++) {
        const seq = rampFrames + i;
        const r = result(seq, { center: { x: stopX, y: 0 } });
        const out = pred.process(r);
        errs.push(Math.abs(out.center!.x - stopX));
      }
      return errs;
    };
    const immErr = overshoot(imm, 30);
    const caErr = overshoot(ca, 30);

    // Right after the stop the IMM (able to switch to CP/CV) overshoots LESS
    // than the CA-only filter, which keeps coasting on stale acceleration.
    expect(immErr[2]).toBeLessThan(caErr[2]);
    // And the IMM's overshoot decays back to (near) zero within N frames.
    expect(immErr[15]).toBeLessThan(2);
    expect(immErr[29]).toBeLessThan(1);
  });
});

describe("ImmPredictor — measurement gaps (found = false)", () => {
  it("propagates through misses (covariance grows), snaps back on reacquire", () => {
    const delayMs = 50;
    const pred = new ImmPredictor({ delayMs });
    const vx = 100;
    feedCV(pred, vx, 0, 40);
    const varBefore = pred.debugPosVar()[0];

    // Three consecutive misses — predict-only, no measurement update.
    for (let i = 0; i < 3; i++) {
      const r = result(40 + i, { found: false, center: null, bbox: null });
      const out = pred.process(r);
      expect(out.found).toBe(false); // found=false rides downstream untouched
      expect(out.center).toBeNull();
    }
    const varAfter = pred.debugPosVar()[0];
    expect(varAfter).toBeGreaterThan(varBefore); // uncertainty inflated

    // Reacquire ON the continued CV trajectory: the estimate snapped back (the
    // filter kept coasting through the gap — NOT reset), so the lead is still
    // ≈ v·Δ (a reset would have zeroed the velocity → shift ≈ 0).
    const seq = 43;
    const t = Number(FRAME_NS * BigInt(seq)) / 1e9;
    const r = result(seq, { center: { x: vx * t, y: 0 } });
    const out = pred.process(r);
    const shift = out.center!.x - r.center!.x;
    expect(shift).toBeGreaterThan(2); // still leading — not gated/reset
    expect(shift).toBeCloseTo(vx * (delayMs / 1000), 0);
  });

  it("does not diverge across a long miss streak", () => {
    const pred = new ImmPredictor({ delayMs: 50 });
    feedCV(pred, 100, 0, 40);
    for (let i = 0; i < 20; i++)
      pred.process(result(40 + i, { found: false, center: null, bbox: null }));
    const [vx, vy] = pred.debugPosVar();
    expect(Number.isFinite(vx)).toBe(true);
    expect(Number.isFinite(vy)).toBe(true);
  });
});

describe("ImmPredictor — override (drag) passthrough + reset", () => {
  it("passes overridden results through UNTOUCHED and resets the filter", () => {
    const pred = new ImmPredictor({ delayMs: 50 });
    feedCV(pred, 150, 0, 40); // build up velocity

    const drag = result(40, { overridden: true, center: { x: 999, y: 999 } });
    expect(pred.process(drag)).toBe(drag); // untouched, same object

    // After the drag reset, the first normal result is cold again → passthrough
    // (no stale velocity yanks the mirrors).
    const first = result(41, { center: { x: 999, y: 999 } });
    expect(pred.process(first)).toBe(first);
  });
});

describe("ImmPredictor — discontinuities (innovation gate)", () => {
  it("reinitializes at the measurement on a teleport (passthrough, no drag)", () => {
    const delayMs = 50;
    const pred = new ImmPredictor({ delayMs });
    const vx = 100;
    feedCV(pred, vx, 0, 40);

    // A wild jump far outside the predicted covariance — a teleport / re-arm.
    const jump = result(40, { center: { x: 5000, y: 5000 } });
    const out = pred.process(jump);
    // Gated → reinit AT the measurement: output is the measurement (shift ≈ 0),
    // NOT the stale-velocity prediction and NOT dragged toward the old track.
    expect(out.center!.x).toBeCloseTo(5000, 0);
    expect(out.center!.y).toBeCloseTo(5000, 0);

    // After the reinit the velocity is zeroed, so the next result predicts a
    // near-zero shift (no stale dynamics carried across the discontinuity).
    const next = result(41, { center: { x: 5000, y: 5000 } });
    const out2 = pred.process(next);
    expect(out2.center!.x).toBeCloseTo(5000, 0);
    expect(out2.center!.y).toBeCloseTo(5000, 0);
  });
});

describe("ImmPredictor — numerical / dt guards", () => {
  it("non-positive dt (duplicate / out-of-order stamp) passes through unchanged", () => {
    const pred = new ImmPredictor({ delayMs: 50 });
    feedCV(pred, 100, 0, 40);
    // Same timestamp as the last frame (dt = 0) → passthrough, no state change.
    const dupTs = T0 + FRAME_NS * 39n;
    const dup = result(40, { center: { x: 12, y: 34 }, ts: dupTs });
    expect(pred.process(dup)).toBe(dup);
    // A stamp BEFORE the last (dt < 0) → passthrough.
    const back = result(41, { center: { x: 12, y: 34 }, ts: T0 });
    expect(pred.process(back)).toBe(back);
  });

  it("a huge time gap reinitializes at the measurement (no wild propagation)", () => {
    const delayMs = 50;
    const pred = new ImmPredictor({ delayMs, maxGapMs: 200 });
    const vx = 100;
    feedCV(pred, vx, 0, 40);
    // 1 s gap ≫ maxGapMs → reset at the measurement, output = measurement.
    const bigTs = T0 + FRAME_NS * 39n + 1_000_000_000n;
    const after = result(41, { center: { x: 777, y: 0 }, ts: bigTs });
    const out = pred.process(after);
    expect(out.center!.x).toBeCloseTo(777, 3); // no coasting across the gap
  });

  it("never emits a non-finite center", () => {
    const pred = new ImmPredictor({ delayMs: 50 });
    const outs: TrackResult[] = [];
    for (let i = 0; i < 60; i++) outs.push(feedCV(pred, 300, -220, 1, i).out);
    for (const o of outs)
      if (o.center) {
        expect(Number.isFinite(o.center.x)).toBe(true);
        expect(Number.isFinite(o.center.y)).toBe(true);
      }
  });
});
