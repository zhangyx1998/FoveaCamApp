// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

// `clamp` comes from `./util/math` (Vue-free, no imports at all) rather than
// `./util` — that module pulls in `vue` (several of its other exports use
// `ref`/`computed`), and this file must stay Vue-free: the orchestrator's
// disparity-scope session (docs/history/refactor/orchestrator.md §7.1 S1a) was the
// first orchestrator-side `@lib/pid` consumer, and pulling `vue` into the
// orchestrator bundle from here broke the "Vue-free orchestrator" hard rule
// (§3) — a ~1.3 MB bundle-size jump caught it.
import { clamp } from "./util/math.js";
// Type-only (erased at compile) — keeps this module Vue-free AND core-runtime-
// free (see the header note): `Point2d` is just `{ x, y }`, no addon pulled in.
import type { Point2d } from "core/Geometry";

/**
 * The ONE reusable, serializable PID parameter record (unified per the PID-node
 * directive, docs/proposals/pid-nodes-and-view-replumb.md §"PID node design").
 * Every controller — scalar {@link PID} and {@link PID2D} per-axis — is
 * parameterized by this shape, so a module declares gains/limits once and feeds
 * the same object to construction, {@link PID.setParams}, and any UI binding.
 *
 * A superset of the runtime knobs in {@link PIDOptions} minus `initial` (params
 * describe the CONTROLLER, not its live integrator seed): `kp`/`ki`/`kd` are
 * required (the caller states intent — no silent zero), the two limit pairs are
 * optional (default unbounded / = `limits`). Structurally assignable to
 * {@link PIDOptions}, so `new PID(params)` just works.
 */
export interface PidParams {
  kp: number;
  ki: number;
  kd: number;
  /** Output saturation `[min, max]` (default unbounded). */
  limits?: [number, number];
  /** Integrator clamp for anti-windup (default = `limits`). */
  integralLimits?: [number, number];
}

export interface PIDOptions {
  /** Proportional gain. */
  kp?: number;
  /** Integral gain. */
  ki?: number;
  /** Derivative gain. */
  kd?: number;
  /** Output saturation `[min, max]` (default unbounded). */
  limits?: [number, number];
  /** Integrator clamp for anti-windup (default = `limits`). */
  integralLimits?: [number, number];
  /** Initial integrator value (default 0). */
  initial?: number;
}

const UNBOUNDED: [number, number] = [-Infinity, Infinity];

/**
 * Minimal scalar PID controller in parallel form:
 *
 *   output = kp·e + ki·∫e·dt + kd·de/dt        (saturated to `limits`)
 *
 * The integrator is clamped to `integralLimits` every step (anti-windup), so it
 * can double as the command in incremental / velocity-form loops: with
 * `kp = kd = 0` the clamped integral *is* the output. That is how each
 * auto-vergence DOF is driven (`command += gain·error·dt`, bounded to a physical
 * range), and the same shape the calibration trackers use.
 *
 * `dt` is whatever time unit the gains are defined against (frames, seconds, …);
 * supplying a consistent, normalized step is the caller's responsibility.
 */
export class PID {
  kp: number;
  ki: number;
  kd: number;
  limits: [number, number];
  integralLimits: [number, number];
  private integral: number;
  private prevError: number | null = null;

  constructor(opts: PIDOptions = {}) {
    this.kp = opts.kp ?? 0;
    this.ki = opts.ki ?? 0;
    this.kd = opts.kd ?? 0;
    this.limits = opts.limits ?? UNBOUNDED;
    this.integralLimits = opts.integralLimits ?? this.limits;
    this.integral = clamp(opts.initial ?? 0, this.integralLimits);
  }

  /** Current integrator value (the command, in incremental loops). */
  get value() {
    return this.integral;
  }
  set value(v: number) {
    this.integral = clamp(v, this.integralLimits);
  }

  /** Reset the integrator (default 0) and derivative memory. */
  reset(value = 0) {
    this.integral = clamp(value, this.integralLimits);
    this.prevError = null;
  }

  /**
   * Re-parameterize a LIVE controller from the uniform {@link PidParams} shape
   * (gain retune, e.g. a tuning-slider write) WITHOUT disturbing the integrator
   * or derivative memory — the loop keeps running through the change. Mirrors
   * the constructor's limit defaulting: passing `limits` without
   * `integralLimits` re-derives the integral clamp from it (so a tightened
   * output bound also tightens anti-windup); omitting a limit leaves it as-is.
   * The live integrator is re-clamped to the (possibly narrowed) bound
   * immediately, so a shrunk range can't leave a stale, out-of-range command.
   */
  setParams(p: PidParams): void {
    this.kp = p.kp;
    this.ki = p.ki;
    this.kd = p.kd;
    if (p.limits) this.limits = p.limits;
    if (p.integralLimits) this.integralLimits = p.integralLimits;
    else if (p.limits) this.integralLimits = p.limits;
    this.integral = clamp(this.integral, this.integralLimits);
  }

  /**
   * Advance one control step.
   * @param error setpoint − measurement
   * @param dt normalized time step (default 1)
   * @returns the saturated control output
   */
  step(error: number, dt = 1): number {
    this.integral = clamp(
      this.integral + this.ki * error * dt,
      this.integralLimits,
    );
    let derivative = 0;
    if (this.kd !== 0 && this.prevError !== null && dt > 0)
      derivative = (error - this.prevError) / dt;
    this.prevError = error;
    return clamp(
      this.kp * error + this.integral + this.kd * derivative,
      this.limits,
    );
  }
}

/** Per-axis params for a {@link PID2D} — the x and y channels are independent
 *  scalar controllers, so each carries its own full {@link PidParams} (the
 *  vergence pan DOF, e.g., shares gains across axes but different physical
 *  limits are common — verge vs. v_shift live on separate `PID`s already). */
export interface Pid2dParams {
  x: PidParams;
  y: PidParams;
}

/**
 * Two independent scalar {@link PID}s driven as one `{ x, y }` controller — the
 * PID-2D variant the directive calls for (a `Point2d` error in, a `Point2d`
 * command out). It is deliberately NOT a coupled 2-vector controller: each axis
 * integrates/saturates on its own {@link PidParams}, which is exactly what the
 * vergence `pan` DOF wants (common-mode ray correction whose x and y are
 * physically separate). Everything the scalar `PID` guarantees (velocity-form
 * integrator = command, anti-windup clamp, dt-scaling) holds per axis.
 */
export class PID2D {
  readonly x: PID;
  readonly y: PID;

  constructor(p?: Partial<Pid2dParams>) {
    this.x = new PID(p?.x);
    this.y = new PID(p?.y);
  }

  /** Retune either/both axes live (see {@link PID.setParams}); an omitted axis
   *  is left untouched. */
  setParams(p: Partial<Pid2dParams>): void {
    if (p.x) this.x.setParams(p.x);
    if (p.y) this.y.setParams(p.y);
  }

  /** Advance both axes one step. `dt` is shared (both channels are driven at
   *  the same call rate). */
  step(error: Point2d, dt = 1): Point2d {
    return { x: this.x.step(error.x, dt), y: this.y.step(error.y, dt) };
  }

  /** Current per-axis integrator values as a point (the 2D command). */
  get value(): Point2d {
    return { x: this.x.value, y: this.y.value };
  }
  set value(v: Point2d) {
    this.x.value = v.x;
    this.y.value = v.y;
  }

  /** Reset both integrators (default {0,0}) and derivative memory. Passing a
   *  point seeds each axis — used by the PID-node override `seed` hook to make
   *  the resumed 2D command continuous with the released override. */
  reset(value?: Point2d): void {
    this.x.reset(value?.x);
    this.y.reset(value?.y);
  }
}
