// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Drag-target SLEW for the manual-control pacer (value-sweep addendum
// 2026-07-11, manual-control-drag-slew). The 1 ms pacer used to re-push the
// RAW latest pointer target every tick; between pointer samples the pose is
// IDENTICAL, the StreamUpdateGate/MirrorSink dedupes it, and the serial link
// idles at the pointer sample rate (60 Hz mousemove / device-rate rawupdate)
// despite ~600–1000 Hz of governed capacity. Instead the pacer keeps the
// previously COMMANDED pose and slews it toward the latest pointer target
// with a first-order smoother — during motion every tick yields a DISTINCT
// intermediate pose, so the gate passes it and the wire runs at its governed
// capacity with meaningful interpolation (smoother MEMS motion, less step
// excitation). Once within EPSILON the exact target is emitted once and the
// output goes quiet (identical poses → gate dedupe) — no manufactured noise.
//
// Pure + Vue-free (orchestrator-reachable; unit-tested in
// app/test/manual-control-slew.test.ts).

export type SlewPos = { x: number; y: number };
export type SlewPair = { l: SlewPos; r: SlewPos };

/** First-order time constant (ms): the smoothed pose lags a MOVING target by
 *  ~one pointer interval (125 Hz ≈ 8 ms), so perceived drag latency does not
 *  grow; after the pointer stops, the tail settles to EPSILON in a few tens
 *  of ms. */
export const SLEW_TAU_MS = 8;

/** Convergence epsilon (volts, per channel). Just above the DAC LSB
 *  (200 V / 65535 ≈ 3 mV): differences below it are sub-quantization — snap
 *  to the exact target and go quiet. */
export const SLEW_EPSILON_V = 0.005;

/** One pacer tick of the smoother: move `current` toward `target` by the
 *  first-order step `1 − exp(−dt/τ)`. Returns the new commanded pose and
 *  whether it SETTLED (all four channels within epsilon → pose IS the exact
 *  target, so consecutive settled ticks dedupe downstream). Monotonic per
 *  channel (alpha ∈ (0, 1] — never overshoots), converges for any dt > 0. */
export function slewStep(
  current: SlewPair,
  target: SlewPair,
  dtMs: number,
  tauMs: number = SLEW_TAU_MS,
  epsilonV: number = SLEW_EPSILON_V,
): { pose: SlewPair; settled: boolean } {
  const alpha = tauMs > 0 ? 1 - Math.exp(-Math.max(0, dtMs) / tauMs) : 1;
  const step = (c: number, t: number): number => c + (t - c) * alpha;
  const within = (c: number, t: number): boolean => Math.abs(t - c) <= epsilonV;
  const settled =
    within(current.l.x, target.l.x) && within(current.l.y, target.l.y) &&
    within(current.r.x, target.r.x) && within(current.r.y, target.r.y);
  if (settled)
    // Snap: emit the EXACT target (once — afterwards poses are identical and
    // the stream-update gate dedupes them).
    return {
      pose: { l: { ...target.l }, r: { ...target.r } },
      settled: true,
    };
  return {
    pose: {
      l: { x: step(current.l.x, target.l.x), y: step(current.l.y, target.l.y) },
      r: { x: step(current.r.x, target.r.x), y: step(current.r.y, target.r.y) },
    },
    settled: false,
  };
}
