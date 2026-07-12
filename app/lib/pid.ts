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

/** What the derivative term differentiates (see {@link PID.step}):
 *  - `"error"` (default) — the classic `de/dt`; a setpoint step rides straight
 *    into the output (setpoint kick).
 *  - `"measurement"` — `d(−measurement)/dt`, the standard anti-setpoint-kick
 *    form: identical to `"error"` while the setpoint is constant (e = sp − m ⇒
 *    Δe = −Δm), but a moving setpoint no longer excites kd at all. */
export type DerivativeSource = "error" | "measurement";

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
  /** Derivative low-pass time constant in `dt` units (default
   *  {@link DERIVATIVE_TAU}; 0 = raw, unfiltered slope). See {@link PID.step}. */
  dTau?: number;
  /** Derivative source (default `"error"` — zero behavior change for callers
   *  that never pass a measurement). See {@link DerivativeSource}. */
  derivativeOn?: DerivativeSource;
}

/** Default derivative-filter time constant (in `dt` units — frames for the
 *  vergence loop). Chosen a couple of nominal steps wide: enough to flatten
 *  measurement-quantization staircase + the near-zero-dt spikes an uneven step
 *  cadence produces, while keeping the derivative's phase lead useful. */
export const DERIVATIVE_TAU = 2;

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
  /** Derivative-filter time constant ({@link PIDOptions.dTau}). */
  dTau: number;
  /** Derivative source ({@link PIDOptions.derivativeOn}). */
  readonly derivativeOn: DerivativeSource;
  private integral: number;
  /** Previous derivative-source value (error, or −measurement). */
  private prevD: number | null = null;
  /** Low-passed source slope — the derivative term's state (see `step`). */
  private dFiltered = 0;

  constructor(opts: PIDOptions = {}) {
    this.kp = opts.kp ?? 0;
    this.ki = opts.ki ?? 0;
    this.kd = opts.kd ?? 0;
    this.limits = opts.limits ?? UNBOUNDED;
    this.integralLimits = opts.integralLimits ?? this.limits;
    this.dTau = opts.dTau ?? DERIVATIVE_TAU;
    this.derivativeOn = opts.derivativeOn ?? "error";
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
    this.prevD = null;
    this.dFiltered = 0;
  }

  /**
   * Re-bound a LIVE controller (value-sweep 2026-07-11
   * `verge-integral-clamp-stale`). A bare `pid.limits = [...]` assignment is a
   * TRAP: the constructor aliases `integralLimits` to the SAME array when no
   * explicit integral clamp was given, so replacing `limits` with a new array
   * leaves the integrator clamped to the CONSTRUCTION-time bound — and in
   * velocity-form loops the integrator IS the command (the disparity verge
   * DOF stayed clamped to the default-200 mm baseline range on any other
   * rig). This setter updates BOTH bounds (mirroring `setParams`' "limits
   * without integralLimits re-derives the integral clamp") and re-clamps the
   * live integrator so a narrowed range can't strand an out-of-range command.
   */
  setLimits(
    limits: [number, number],
    integralLimits: [number, number] = limits,
  ): void {
    this.limits = limits;
    this.integralLimits = integralLimits;
    this.integral = clamp(this.integral, this.integralLimits);
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
   *
   * The derivative term is LOW-PASSED (first-order, time constant `dTau`):
   * `dState += α·(Δe/dt − dState)` with `α = dt/(dt + dTau)`. The raw slope
   * `Δe/dt` is the one PID term that DIVIDES by dt, so an irregular step
   * cadence (e.g. two steps landing microseconds apart) turns any kd ≠ 0 into
   * an unbounded kick — α → 0 as dt → 0 makes the filter time-consistent: a
   * near-zero-dt step contributes almost nothing, a long gap re-converges in
   * ~dTau. `dTau = 0` degenerates to the raw slope.
   *
   * Under `derivativeOn: "measurement"` the filtered slope is taken over
   * `−measurement` instead of the error (same filter state): a setpoint step
   * never kicks the derivative, while measurement motion responds identically
   * to error mode (Δe = −Δm at constant setpoint). A step with no
   * `measurement` supplied contributes no derivative and leaves the filter
   * memory untouched.
   *
   * @param error setpoint − measurement
   * @param dt normalized time step (default 1)
   * @param measurement the raw measurement (only read in `"measurement"` mode)
   * @returns the saturated control output
   */
  step(error: number, dt = 1, measurement?: number): number {
    this.integral = clamp(
      this.integral + this.ki * error * dt,
      this.integralLimits,
    );
    const source =
      this.derivativeOn === "measurement"
        ? measurement !== undefined
          ? -measurement
          : null
        : error;
    let derivative = 0;
    if (source !== null) {
      if (this.kd !== 0 && this.prevD !== null && dt > 0) {
        const raw = (source - this.prevD) / dt;
        const alpha = this.dTau > 0 ? dt / (dt + this.dTau) : 1;
        this.dFiltered += alpha * (raw - this.dFiltered);
        derivative = this.dFiltered;
      }
      this.prevD = source;
    }
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

  /** Accepts the full per-axis {@link PIDOptions} (a {@link Pid2dParams} is
   *  structurally assignable), so construction-time knobs like `derivativeOn`
   *  reach each axis. */
  constructor(p?: { x?: PIDOptions; y?: PIDOptions }) {
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
   *  the same call rate); `measurement` forwards per axis (see
   *  {@link PID.step}'s `derivativeOn: "measurement"` form). */
  step(error: Point2d, dt = 1, measurement?: Point2d): Point2d {
    return {
      x: this.x.step(error.x, dt, measurement?.x),
      y: this.y.step(error.y, dt, measurement?.y),
    };
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
