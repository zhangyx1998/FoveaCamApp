// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE first-order drag SLEW (spec §drag-slew): slew the commanded pose toward
// the latest pointer target so successive control ticks emit DIFFERING poses the
// MirrorSink gate passes at capacity, then epsilon-snap and go quiet.
// NOTE: manual-control duplicates this ~15-line function — keep the
// constant/shape consistent; a later dedup can hoist both into @lib.

import type { Pos } from "@lib/controller-codec";

/** Slew time constant (ms): perceived drag latency ≈ one pointer interval;
 *  epsilon convergence after motion stops takes a few τ. */
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

/**
 * The drag-slew STATE MACHINE the session drives. ALL drag-path volts writers
 * must route through ONE instance: a raw-target writer mixed among slewed
 * writers alternates the compose floor between two trajectories separated by
 * the slew lag. Seeded from the caller-supplied pose on the first `toward` of a
 * drag; `reset()` on drag end / activate.
 */
export class DragSlew {
  private state: { pose: SlewPose; at: number } | null = null;

  constructor(
    private readonly nowMs: () => number,
    private readonly tauMs = DRAG_SLEW_TAU_MS,
  ) {}

  /** One slewed step toward `target`; seeds from `seed` on the first call of
   *  a drag. dt = time since the previous call (whatever cadence is live). */
  toward(seed: SlewPose, target: SlewPose): SlewPose {
    const t = this.nowMs();
    if (!this.state) {
      this.state = {
        pose: { l: { ...seed.l }, r: { ...seed.r } },
        at: t,
      };
    }
    const r = slewStep(this.state.pose, target, t - this.state.at, this.tauMs);
    this.state = { pose: r.pose, at: t };
    return r.pose;
  }

  reset(): void {
    this.state = null;
  }
}
