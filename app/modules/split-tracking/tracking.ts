// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Split-tracking PURE core (docs/proposals/split-tracking-app.md §"Pinned pure
// module"): the geometry + per-eye visual-servo control law + the single-side
// TrackResult reducer, all side-effect-free and unit-testable with synthetic
// inputs (no addon, no controller, no Vue). This module is the SINGLE SOURCE for
// the shared `Eye`/`TileSize`/`PidGains` types — `contract.ts` re-imports them
// from here so the two never drift.
//
// The two eyes run INDEPENDENT single-eye servos (no stereo/vergence coupling);
// each owns its own `EyeServo` + miss counter and never touches the other side.

import type { Point2d, Rect, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";

// ---- shared types (single source; re-exported by contract.ts) ---------------

/** Which fovea/mirror this state belongs to. */
export type Eye = "L" | "R";

// NB: `type` aliases (not `interface`) — object type aliases carry an implicit
// index signature, so these satisfy the contract framework's `Serializable`
// state/telemetry constraint when `contract.ts` re-imports them.

/** Tracker-template / annotation tile, in fovea image pixels. */
export type TileSize = {
  w: number;
  h: number;
};

/** Per-axis PID gains for the per-eye servo (applied identically to x & y). */
export type PidGains = {
  kp: number;
  ki: number;
  kd: number;
};

// ---- tunables ----------------------------------------------------------------

/** Default square tile edge (px) — the 512² template annotated in the view. */
export const DEFAULT_TILE = 512;
/** Drawer clamp: smallest usable tile edge (px). */
export const MIN_TILE = 64;
/** Drawer clamp: largest usable tile edge (px). */
export const MAX_TILE = 1024;

/**
 * SAFE, conservative starting gains — a bench RIG tunes these (drawer-editable
 * via `setGains`). Deliberately gentle: low `kp` (correct a small fraction of
 * the volt error per tick), tiny `ki` (slowly trim residual bias without
 * winding up), small `kd` (a little damping). Chosen to be stable-by-default on
 * the integrating mirror plant rather than fast — the operator raises them.
 * RIG-TUNABLE — not a shipped operating point.
 */
export const DEFAULT_GAINS: PidGains = { kp: 0.15, ki: 0.01, kd: 0.02 };

/**
 * Suggested per-tick volt step clamp for `EyeServo` (the `maxStepV` ctor arg).
 * The session picks the real value; this is a conservative placeholder given
 * the controller's ~0..200 V range (see controller-codec `volt2dac`) — a small
 * slew ceiling so a bad Jacobian sign or a large reacquire error can never fling
 * the mirror. RIG-TUNABLE.
 */
export const DEFAULT_MAX_STEP_V = 1.0;

/**
 * Consecutive delivered misses (armed) before the side is declared lost — the
 * `reduceResult` threshold. Matches disparity-scope's `lostTolerance` default
 * (tracker-feed.ts) so both apps agree on "how many misses is a drop".
 */
export const TRACKER_LOST_TOLERANCE = 10;

// ---- geometry ----------------------------------------------------------------

/** Row-major 2×2 matrix `[[a,b],[c,d]]` (a=[0], b=[1], c=[2], d=[3]). */
export type Mat2 = readonly [number, number, number, number];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Arm ROI centered on `center`, then SHIFTED (never shrunk) to lie fully inside
 * `[0,0,frame]`. If the tile is larger than the frame on an axis, that axis is
 * clamped to the frame extent and centered (origin 0). Rounds to integer px.
 * Postcondition (the `arm()` precondition): `0 ≤ x`, `0 ≤ y`,
 * `x+width ≤ frame.width`, `y+height ≤ frame.height` — never partial/negative.
 */
export function tileRect(center: Point2d, tile: TileSize, frame: Size): Rect {
  const fw = Math.round(frame.width);
  const fh = Math.round(frame.height);
  // Clamp the tile to the frame (oversize → frame extent), then shift-to-fit.
  const width = Math.min(Math.round(tile.w), fw);
  const height = Math.min(Math.round(tile.h), fh);
  const x = clamp(Math.round(center.x - width / 2), 0, fw - width);
  const y = clamp(Math.round(center.y - height / 2), 0, fh - height);
  return { x, y, width, height };
}

/**
 * Apply the 2×2 inverse Jacobian `jInv` (volt-per-px, `[[a,b],[c,d]]`) to a
 * pixel error → a volt error. The session supplies `jInv` from the calibration
 * geometry.
 */
export function applyJInv(errPx: Point2d, jInv: Mat2): Point2d {
  const [a, b, c, d] = jInv;
  return {
    x: a * errPx.x + b * errPx.y,
    y: c * errPx.x + d * errPx.y,
  };
}

// ---- per-eye visual servo ----------------------------------------------------

/**
 * Per-eye visual servo: independent PID (per axis) over the `jInv`-mapped VOLT
 * error, emitting a per-tick volt DELTA clamped to ±`maxStepV`. Integrator +
 * derivative are taken on the volt error; conditional-integration anti-windup
 * freezes the integrator while the step is saturated in the same direction
 * (never letting it wind up), and `reset()` zeroes all state on (re)arm.
 * `dtSec ≤ 0` skips the D/I update and returns a P-only (still clamped) step.
 */
export class EyeServo {
  private gains: PidGains;
  private readonly maxStepV: number;
  private ix = 0;
  private iy = 0;
  private ex = 0; // last errVolt.x
  private ey = 0; // last errVolt.y

  constructor(gains: PidGains, maxStepV: number) {
    this.gains = { ...gains };
    this.maxStepV = Math.abs(maxStepV);
  }

  setGains(g: PidGains): void {
    this.gains = { ...g };
  }

  /** Zero the integrator and last-error (call on every (re)arm). */
  reset(): void {
    this.ix = 0;
    this.iy = 0;
    this.ex = 0;
    this.ey = 0;
  }

  /** Volt DELTA to add this tick. `errPx` = tracked center − frame center. */
  step(errPx: Point2d, jInv: Mat2, dtSec: number): Pos {
    const err = applyJInv(errPx, jInv);
    return {
      x: this.axis(err.x, "x", dtSec),
      y: this.axis(err.y, "y", dtSec),
    };
  }

  private axis(e: number, axis: "x" | "y", dtSec: number): number {
    const { kp, ki, kd } = this.gains;
    const max = this.maxStepV;

    // dt ≤ 0 (first tick / stalled clock): P-only, touch no state.
    if (!(dtSec > 0)) {
      return clamp(kp * e, -max, max);
    }

    const prevErr = axis === "x" ? this.ex : this.ey;
    const prevI = axis === "x" ? this.ix : this.iy;

    const deriv = (e - prevErr) / dtSec;
    const nextI = prevI + e * dtSec;
    const unclamped = kp * e + ki * nextI + kd * deriv;
    const out = clamp(unclamped, -max, max);

    // Conditional-integration anti-windup: commit the integrator update only
    // when the step is NOT saturated, OR when this error would UNWIND it (its
    // sign opposes the saturated output). Otherwise freeze — no windup.
    const saturated = out !== unclamped;
    const commit = !saturated || Math.sign(e) !== Math.sign(unclamped);
    const i = commit ? nextI : prevI;

    if (axis === "x") {
      this.ix = i;
      this.ex = e;
    } else {
      this.iy = i;
      this.ey = e;
    }
    return out;
  }
}

// ---- single-side TrackResult reducer ----------------------------------------

/** Per-side routing sinks — mirror of disparity-scope's handlers, one eye. */
export interface SideHandlers {
  /** A found result while armed — `center`/`bbox` in fovea image px. */
  onTrack(c: Point2d, b: Rect): void;
  /** An OVERRIDDEN result — `c` is the drag point (bypasses the armed gate). */
  onDrag(c: Point2d): void;
  /** `TRACKER_LOST_TOLERANCE` consecutive armed misses reached. */
  onLost(): void;
}

/**
 * Route ONE side's `TrackResult` (disparity-scope tracker-feed shape, single
 * eye) and return the new consecutive-miss count:
 *  - `overridden` → `onDrag(center)` (guarded) and reset misses to 0;
 *  - `!armed` → ignore, misses UNCHANGED (a future re-arm starts fresh);
 *  - armed & found w/ center+bbox → `onTrack`, reset misses to 0;
 *  - armed miss (not found / missing geometry) → misses+1, firing `onLost`
 *    once the count reaches `TRACKER_LOST_TOLERANCE` (returns misses+1 either
 *    way — the caller stops servoing on the lost edge).
 */
export function reduceResult(
  r: { found: boolean; center: Point2d | null; bbox: Rect | null; overridden: boolean },
  armed: boolean,
  misses: number,
  handlers: SideHandlers,
): number {
  if (r.overridden) {
    if (r.center) handlers.onDrag(r.center);
    return 0;
  }
  if (!armed) return misses;
  if (r.found && r.center && r.bbox) {
    handlers.onTrack(r.center, r.bbox);
    return 0;
  }
  const next = misses + 1;
  if (next >= TRACKER_LOST_TOLERANCE) handlers.onLost();
  return next;
}
