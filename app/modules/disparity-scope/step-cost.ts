// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Scripted-target-step cost — PURE trace scoring for the CMA-ES polish stage
// (docs/proposals/vergence-loop-tuning.md §1): ITAE + overshoot penalty +
// actuation-effort term, all normalized by the step magnitude so costs compare
// across step sizes. Behavior spec: docs/spec/disparity-scope.md#autotune.

export interface StepTraceSample {
  /** Time since the target step (loop-dt units). */
  t: number;
  /** Signed control error for the stepped DOF. */
  error: number;
  /** DOF command (integrator value) at this sample — feeds the effort term. */
  command?: number;
}

export interface StepCostWeights {
  /** Quadratic penalty weight on normalized overshoot. */
  overshoot: number;
  /** Linear weight on normalized command total-variation. */
  effort: number;
}

export const DEFAULT_STEP_WEIGHTS: StepCostWeights = {
  overshoot: 2,
  effort: 0.05,
};

/** Minimum trace length below which a candidate is unmeasurable. */
export const MIN_TRACE_SAMPLES = 5;
/** Cost assigned to an unmeasurable candidate (finite so CMA-ES stays sane). */
export const UNMEASURABLE_COST = 1e6;

/**
 * Score a step-response trace. `ref` (default: the trace's peak |error| — the
 * observed step magnitude; robust to the pipeline-delay lead-in where the
 * error is still ~0) normalizes every term:
 *
 * - ITAE `Σ t·|e|·Δt`, normalized to 1.0 == error held at `ref` all window;
 * - overshoot = the excursion past zero opposite the step's sign (the sign of
 *   the error at its peak), squared;
 * - effort = total variation of `command`, per unit `ref`.
 */
export function stepCost(
  trace: readonly StepTraceSample[],
  weights: StepCostWeights = DEFAULT_STEP_WEIGHTS,
  ref?: number,
): number {
  if (trace.length < MIN_TRACE_SAMPLES) return UNMEASURABLE_COST;
  let peak = 0;
  let peakSign = 1;
  for (const s of trace) {
    const a = Math.abs(s.error);
    if (a > peak) {
      peak = a;
      peakSign = Math.sign(s.error) || 1;
    }
  }
  const r = ref ?? peak;
  if (!(r > 0)) return UNMEASURABLE_COST;
  let itae = 0;
  let overshoot = 0;
  let effort = 0;
  for (let i = 1; i < trace.length; i++) {
    const prev = trace[i - 1]!;
    const cur = trace[i]!;
    const dt = cur.t - prev.t;
    if (dt <= 0) continue;
    itae += cur.t * Math.abs(cur.error) * dt;
    overshoot = Math.max(overshoot, -peakSign * cur.error);
    if (cur.command !== undefined && prev.command !== undefined)
      effort += Math.abs(cur.command - prev.command);
  }
  const T = trace[trace.length - 1]!.t - trace[0]!.t;
  if (!(T > 0)) return UNMEASURABLE_COST;
  const itaeN = itae / (r * (T * T) * 0.5);
  const osN = Math.max(0, overshoot) / r;
  return itaeN + weights.overshoot * osN * osN + weights.effort * (effort / r);
}

/** Mean |error| per unit `ref` — the cross-coupling term for the DOFs the
 *  scripted step should NOT excite. */
export function regulationCost(
  trace: readonly { error: number }[],
  ref: number,
): number {
  if (trace.length === 0 || !(ref > 0)) return 0;
  let sum = 0;
  for (const s of trace) sum += Math.abs(s.error);
  return sum / trace.length / ref;
}
