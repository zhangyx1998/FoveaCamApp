// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { clamp } from "./util";

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
