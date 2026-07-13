// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE time-axis viewport algebra for the viewer tracks (Vue/DOM-free, unit-
// tested). One coordinate convention: a viewport is a visible [t0, t1] window
// in file-relative ns; screen fraction 0..1 maps linearly across it. Mirrors
// the profiler nodegraph zoomAt's fixed-point-under-anchor semantics in 1D.
// spec: docs/proposals/viewer-timeline-touchup.md (rulings 1/3/5/6)

/** Visible time window in file-relative ns. `t0` may go < 0 and `t1` > duration
 *  only within the bleed allowance (rubber-band); hard bounds clamp there. */
export interface TimeViewport {
  t0: number;
  t1: number;
}

/** Zoom-in floor: the smallest span the tracks view will show (1 ms). */
export const MIN_SPAN_NS = 1e6;

/** Bleed = this fraction of the recording duration, on EACH side — the empty
 *  strip before t=0 / after the end that marks the recording boundary and
 *  gives the rubber-band somewhere to stretch into. */
export const BLEED_FRACTION = 0.05;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** The whole recording, edge to edge (no bleed): [0, duration]. */
export function fullViewport(durationNs: number): TimeViewport {
  return { t0: 0, t1: Math.max(0, durationNs) };
}

/** Bleed width (ns) for a recording — `BLEED_FRACTION` of its duration. */
export function bleedNs(durationNs: number): number {
  return BLEED_FRACTION * Math.max(0, durationNs);
}

/** Clamp a viewport into the HARD bleed bounds [−bleed, duration+bleed] by a
 *  rigid translation (span preserved). A span that fills or exceeds the whole
 *  bleed window is centered on it. */
function clampToHard(vp: TimeViewport, durationNs: number): TimeViewport {
  const bleed = bleedNs(durationNs);
  const lo = -bleed;
  const hi = Math.max(0, durationNs) + bleed;
  const span = vp.t1 - vp.t0;
  if (span >= hi - lo) {
    const mid = (lo + hi) / 2;
    return { t0: mid - span / 2, t1: mid + span / 2 };
  }
  let t0 = vp.t0;
  let t1 = vp.t1;
  if (t0 < lo) {
    t1 += lo - t0;
    t0 = lo;
  }
  if (t1 > hi) {
    t0 -= t1 - hi;
    t1 = hi;
  }
  return { t0, t1 };
}

/** Zoom by `factor` (>1 zooms IN → smaller span) keeping the time at
 *  `anchorFrac` (0..1 of the tracks width) fixed on screen (ruling 5; nodegraph
 *  zoomAt precedent). Span clamps to [MIN_SPAN_NS, duration + 2·bleed], then the
 *  result pans into the hard bleed bounds. */
export function zoomAt(
  vp: TimeViewport,
  factor: number,
  anchorFrac: number,
  durationNs: number,
): TimeViewport {
  const span = vp.t1 - vp.t0;
  const anchorNs = vp.t0 + anchorFrac * span;
  const maxSpan = Math.max(MIN_SPAN_NS, Math.max(0, durationNs) + 2 * bleedNs(durationNs));
  const nextSpan = clamp(span / (factor > 0 ? factor : 1), MIN_SPAN_NS, maxSpan);
  // Keep anchorNs under anchorFrac.
  const t0 = anchorNs - anchorFrac * nextSpan;
  return clampToHard({ t0, t1: t0 + nextSpan }, durationNs);
}

/** Pan by `deltaNs` (rigid translation) with rubber-band SOFTENING past the
 *  logical bounds [0, duration]: while the leading edge is inside [0, duration]
 *  motion is 1:1; the portion of the delta that pushes it past compresses by a
 *  fixed resistance (≈0.35). Nothing may exceed the hard bounds
 *  [−bleed, duration+bleed]. */
export function panSoft(
  vp: TimeViewport,
  deltaNs: number,
  durationNs: number,
): TimeViewport {
  const RESIST = 0.35;
  const span = vp.t1 - vp.t0;
  const dur = Math.max(0, durationNs);
  if (deltaNs === 0) return { t0: vp.t0, t1: vp.t1 };

  if (deltaNs < 0) {
    // Leading LEFT edge (t0) heads toward / below 0.
    const start = vp.t0;
    const target = start + deltaNs;
    let t0: number;
    if (start >= 0 && target >= 0) t0 = target; // fully inside → 1:1
    else if (start >= 0) t0 = target * RESIST; // crosses 0: excess compresses
    else t0 = start + deltaNs * RESIST; // already past → whole delta compresses
    return clampToHard({ t0, t1: t0 + span }, durationNs);
  }
  // deltaNs > 0: leading RIGHT edge (t1) heads toward / above duration.
  const start = vp.t1;
  const target = start + deltaNs;
  let t1: number;
  if (start <= dur && target <= dur) t1 = target;
  else if (start <= dur) t1 = dur + (target - dur) * RESIST;
  else t1 = start + deltaNs * RESIST;
  return clampToHard({ t0: t1 - span, t1 }, durationNs);
}

/** The spring-back target after a pan release left the viewport out of the
 *  LOGICAL bounds: the nearest legal window with t0 ≥ 0 and t1 ≤ duration,
 *  span preserved. Identity when already legal. Degenerate: a span ≥ duration
 *  can't be legal, so it centers on the recording. */
export function settleTarget(vp: TimeViewport, durationNs: number): TimeViewport {
  const span = vp.t1 - vp.t0;
  const dur = Math.max(0, durationNs);
  if (span >= dur) {
    const mid = dur / 2;
    return { t0: mid - span / 2, t1: mid + span / 2 };
  }
  let t0 = vp.t0;
  let t1 = vp.t1;
  if (t0 < 0) {
    t1 -= t0;
    t0 = 0;
  }
  if (t1 > dur) {
    t0 -= t1 - dur;
    t1 = dur;
  }
  return { t0, t1 };
}

/** Pointer x → time under the viewport, UNclamped (may fall outside [t0, t1]).
 *  Degenerate zero width → t0. */
export function nsAtX(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  vp: TimeViewport,
): number {
  if (!(rectWidth > 0)) return vp.t0;
  const frac = (clientX - rectLeft) / rectWidth;
  return vp.t0 + frac * (vp.t1 - vp.t0);
}

/** Time → viewport fraction (0..1 inside the window; may exceed both ends).
 *  Degenerate zero/negative span → 0. */
export function fracOf(ns: number, vp: TimeViewport): number {
  const span = vp.t1 - vp.t0;
  if (!(span > 0)) return 0;
  return (ns - vp.t0) / span;
}

/** A ruler tick: `major` ticks (round decade multiples) carry a `label`; minor
 *  ticks have `label: null`. Negative ns are labeled only when major. */
export interface RulerTick {
  ns: number;
  major: boolean;
  label: string | null;
}

const NICE_MANTISSAS = [1, 2, 5, 10] as const;

/** Round a raw ns step to the nearest 1/2/5·10^k rung (nearest in log space —
 *  keeps tick spacing within ~1.5× of the target). */
function niceStepNs(rawStepNs: number): number {
  if (!(rawStepNs > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStepNs)));
  const frac = rawStepNs / pow; // [1, 10)
  let best: number = NICE_MANTISSAS[0]!;
  let bestErr = Infinity;
  for (const c of NICE_MANTISSAS) {
    const err = Math.abs(Math.log(c) - Math.log(frac));
    if (err < bestErr) {
      bestErr = err;
      best = c;
    }
  }
  return best * pow;
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const MINUS = "−"; // typographic minus (matches the ruler's "−0:01")

/** Format a tick time. Precision adapts to the (major) step: ≥1 s → mm:ss;
 *  ≥1 ms → mm:ss.SSS; finer → ss.SSSSSS. Negatives get a leading minus. */
function formatTick(ns: number, majorStepNs: number): string {
  const neg = ns < 0;
  const t = Math.abs(ns);
  let body: string;
  if (majorStepNs >= 1e9) {
    const sec = Math.round(t / 1e9);
    body = `${Math.floor(sec / 60)}:${pad(sec % 60, 2)}`;
  } else if (majorStepNs >= 1e6) {
    const totalMs = Math.round(t / 1e6);
    const sec = Math.floor(totalMs / 1000);
    body = `${Math.floor(sec / 60)}:${pad(sec % 60, 2)}.${pad(totalMs % 1000, 3)}`;
  } else {
    const sec = Math.floor(t / 1e9);
    const micros = Math.round((t - sec * 1e9) / 1e3);
    body = `${sec}.${pad(micros, 6)}`;
  }
  return neg ? MINUS + body : body;
}

/** Ruler ticks over the FULL viewport (incl. bleed) at ~`targetPx` spacing on a
 *  1/2/5·10^k ns ladder (ruling 3). Major ticks land on round decade multiples
 *  and carry labels; minor ticks fill in between unlabeled. */
export function rulerTicks(
  vp: TimeViewport,
  widthPx: number,
  targetPx = 80,
): RulerTick[] {
  const span = vp.t1 - vp.t0;
  if (!(span > 0) || !(widthPx > 0)) return [];
  const step = niceStepNs((targetPx * span) / widthPx);
  const pow = Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
  const mant = Math.round(step / pow); // 1 | 2 | 5
  const majorStep = step * (mant === 5 ? 2 : 5); // → next round decade
  const ticks: RulerTick[] = [];
  const first = Math.ceil(vp.t0 / step - 1e-9);
  const last = Math.floor(vp.t1 / step + 1e-9);
  for (let k = first; k <= last; k++) {
    const ns = k * step;
    const major = Math.abs(ns / majorStep - Math.round(ns / majorStep)) < 1e-6;
    ticks.push({ ns, major, label: major ? formatTick(ns, majorStep) : null });
  }
  return ticks;
}

/** Smooth playhead (ruling 6): while playing, extrapolate the last worker
 *  position by wall-clock elapsed · rate, clamped to [0, duration]. Paused /
 *  scrubbing → `lastNs` unchanged. */
export function interpolatePlayhead(
  lastNs: number,
  lastAtMs: number,
  nowMs: number,
  rate: number,
  playing: boolean,
  durationNs: number,
): number {
  if (!playing) return lastNs;
  const projected = lastNs + (nowMs - lastAtMs) * 1e6 * rate;
  return clamp(projected, 0, Math.max(0, durationNs));
}
