// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE fps detection (median interval) + temporal frame-blend math for the
// viewer export (renderer-safe, Node-free, unit-tested).
// spec: docs/spec/viewer.md#export

/** Median of a numeric array (returns 0 for an empty array). Copies + sorts. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The detected export fps for a stream, from its frame log-times (ns, sorted
 *  ascending). The MEDIAN inter-frame interval → fps = 1e9 / medianDeltaNs, so a
 *  handful of dropped frames (a few long gaps) don't skew the estimate the way a
 *  mean would (spec 6). Zero/negative deltas (duplicate timestamps) are dropped
 *  before the median. Returns 0 when fewer than two usable intervals exist (the
 *  caller falls back to a sane default / the manual field). */
export function detectFps(timestampsNs: readonly number[]): number {
  const deltas: number[] = [];
  for (let i = 1; i < timestampsNs.length; i++) {
    const d = timestampsNs[i]! - timestampsNs[i - 1]!;
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return 0;
  const med = median(deltas);
  return med > 0 ? 1e9 / med : 0;
}

/** Even sample grid over `[startNs, endNs]` at `fps` (the "more-accurate"
 *  resample timebase — spec 7). Sample k is at `startNs + k * 1e9/fps`, up to
 *  and including the last grid point that is ≤ endNs. Always yields at least one
 *  sample (the start) when the span is non-negative and fps > 0. */
export function uniformTimeline(startNs: number, endNs: number, fps: number): number[] {
  if (!(fps > 0) || endNs < startNs) return startNs <= endNs ? [startNs] : [];
  const stepNs = 1e9 / fps;
  const out: number[] = [];
  // Guard against a pathological (tiny fps · huge span) blow-up: cap the sample
  // count. 1e7 frames is far past any real recording; the caller documents it.
  const n = Math.min(Math.floor((endNs - startNs) / stepNs), 10_000_000);
  for (let k = 0; k <= n; k++) out.push(startNs + k * stepNs);
  return out;
}

/** Temporal blend weights for a sample time `tNs` straddled by two source
 *  frames at `prevNs` ≤ `tNs` ≤ `nextNs` (spec 7). Linear by temporal distance:
 *  `next = (t-prev)/(next-prev)`, `prev = 1-next`. Degenerate span (prev==next,
 *  or t outside the pair) clamps: identical times → all weight on prev; t≤prev →
 *  prev; t≥next → next. Both weights are in [0,1] and sum to 1. */
export function blendWeights(
  tNs: number,
  prevNs: number,
  nextNs: number,
): { prev: number; next: number } {
  const span = nextNs - prevNs;
  if (span <= 0) return { prev: 1, next: 0 };
  const next = Math.min(1, Math.max(0, (tNs - prevNs) / span));
  return { prev: 1 - next, next };
}

/** Blend two equal-length RGBA byte buffers by scalar weights into `out`
 *  (allocated fresh if omitted). `wPrev`/`wNext` need not sum to exactly 1 — the
 *  caller passes `blendWeights` output. Rounds to the nearest byte and clamps to
 *  [0,255]. When one weight is 0 the other buffer is copied verbatim (the
 *  common "sample lands exactly on a frame" fast path). Buffers of unequal
 *  length throw (a programmer error — both are the same WxH·4). */
export function blendFrames(
  prev: Uint8Array,
  next: Uint8Array,
  wPrev: number,
  wNext: number,
  out: Uint8Array = new Uint8Array(prev.length),
): Uint8Array {
  if (prev.length !== next.length)
    throw new Error(`blendFrames: length mismatch ${prev.length} vs ${next.length}`);
  if (wNext <= 0) {
    out.set(prev);
    return out;
  }
  if (wPrev <= 0) {
    out.set(next);
    return out;
  }
  for (let i = 0; i < prev.length; i++) {
    const v = prev[i]! * wPrev + next[i]! * wNext;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
  }
  return out;
}
