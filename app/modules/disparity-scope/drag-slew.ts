// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE first-order drag SLEW (value-sweep 2026-07-11 addendum
// `disparity-drag-slew`). During a drag the mirror pose used to STEP to each
// pointer sample and then sit still — the serial link idled between pointer
// events while the governed stream had ~600–1000 Hz capacity (the compose
// floor re-emits an IDENTICAL pose, which the MirrorSink gate dedupes away by
// design). Slewing the commanded pose toward the latest pointer target with a
// short time constant makes successive control ticks emit DIFFERING poses
// while the target moves — the gate passes them through at capacity — and
// SNAPS to the exact target once within epsilon, going quiet on a static
// target (never manufacturing noise).
//
// τ default 8 ms: perceived drag latency ≈ one pointer interval; convergence
// to epsilon after motion stops takes a few τ (~86% within 2 pointer
// intervals at 120 Hz sampling). NOTE (Lane C parity): manual-control applies
// the same spec with a duplicated copy of this ~15-line function — keep the
// constant/shape consistent; a later dedup can hoist both into @lib.

import type { Pos } from "@lib/controller-codec";

export const DRAG_SLEW_TAU_MS = 8;
/** Per-axis snap threshold (volts) — below this on EVERY axis the slew
 *  returns the exact target (converged; subsequent ticks dedupe to quiet). */
export const DRAG_SLEW_EPSILON_V = 1e-3;

export interface SlewPose {
  l: Pos;
  r: Pos;
}

export interface SlewResult {
  pose: SlewPose;
  /** True when the pose IS the exact target (epsilon-terminated). */
  converged: boolean;
}

/**
 * One first-order step from `current` toward `target` over `dtMs`:
 * `next = current + (target − current) · (1 − e^(−dt/τ))`, per axis, per eye.
 * Monotonic (never overshoots), converges exponentially, and epsilon-snaps to
 * the EXACT target so a settled drag emits one final precise pose then goes
 * quiet. `dt ≤ 0` holds the current pose (unless already within epsilon).
 */
export function slewStep(
  current: SlewPose,
  target: SlewPose,
  dtMs: number,
  tauMs = DRAG_SLEW_TAU_MS,
  epsilonV = DRAG_SLEW_EPSILON_V,
): SlewResult {
  const within =
    Math.abs(target.l.x - current.l.x) <= epsilonV &&
    Math.abs(target.l.y - current.l.y) <= epsilonV &&
    Math.abs(target.r.x - current.r.x) <= epsilonV &&
    Math.abs(target.r.y - current.r.y) <= epsilonV;
  if (within)
    return {
      pose: { l: { ...target.l }, r: { ...target.r } },
      converged: true,
    };
  const alpha = dtMs > 0 && tauMs > 0 ? 1 - Math.exp(-dtMs / tauMs) : 0;
  const lerp = (c: number, t: number): number => c + (t - c) * alpha;
  return {
    pose: {
      l: { x: lerp(current.l.x, target.l.x), y: lerp(current.l.y, target.l.y) },
      r: { x: lerp(current.r.x, target.r.x), y: lerp(current.r.y, target.r.y) },
    },
    converged: false,
  };
}
