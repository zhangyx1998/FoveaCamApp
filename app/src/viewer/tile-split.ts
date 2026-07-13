// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE viewer tile-split math (viewer-tiles-split-and-project.md ruling 3): the
// preview tiles panel is one full-width, non-scrolling row whose slot widths are
// FRACTIONS summing to 1. This module owns every fraction transform — equal
// split, reconcile-to-count (drop/append + renormalize on load), and the
// divider drag — with a single invariant: the returned list has length `n` and
// sums to 1 (within float epsilon), every entry ≥ MIN_TILE_FRACTION. No Vue, no
// DOM, no I/O — unit-tested in isolation.
// spec: docs/spec/viewer.md#tiles

/** Per-tile floor as a fraction of the row — a tile can never be dragged (or
 *  renormalized) below this, so a slot always stays grabbable. */
export const MIN_TILE_FRACTION = 0.06;

/** N tiles → equal fractions summing to 1 (the default layout + the shape used
 *  whenever the tile count changes). `n ≤ 0` → `[]`; `n === 1` → `[1]`. */
export function equalFractions(n: number): number[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  if (n <= 1) return [1];
  return new Array(n).fill(1 / n);
}

/** Are all entries finite, ≥ the floor, and does the list sum to ~1? A list
 *  that passes is trusted verbatim (identity reconcile). The floor check is
 *  skipped for tile counts where an equal split ALREADY falls below the floor
 *  (n too large to honor it) — otherwise a legitimate dense layout could never
 *  validate. */
function isValidFractions(fr: readonly number[], n: number): boolean {
  if (fr.length !== n) return false;
  const floor = n * MIN_TILE_FRACTION >= 1 ? 0 : MIN_TILE_FRACTION - 1e-9;
  let sum = 0;
  for (const f of fr) {
    if (typeof f !== "number" || !Number.isFinite(f) || f < floor || f <= 0) return false;
    sum += f;
  }
  return Math.abs(sum - 1) < 1e-6;
}

/** Renormalize an arbitrary list of positive weights to sum 1, then lift any
 *  entry below the floor and re-settle the rest so the sum stays 1. */
function normalizeToFloor(weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  // If every tile can't clear the floor, fall back to an equal split.
  if (n * MIN_TILE_FRACTION >= 1) return equalFractions(n);
  let total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return equalFractions(n);
  let fr = weights.map((w) => w / total);
  // Clamp under-floor tiles UP to the floor, then rescale the remaining
  // (above-floor) tiles to absorb the deficit. Iterate until stable — clamping
  // one tile can push another under the floor.
  for (let pass = 0; pass < n; pass++) {
    const below = fr.map((f) => f < MIN_TILE_FRACTION);
    if (!below.some(Boolean)) break;
    const floored = below.reduce((c, b) => c + (b ? 1 : 0), 0);
    const freeSum = fr.reduce((s, f, i) => s + (below[i] ? 0 : f), 0);
    const remaining = 1 - floored * MIN_TILE_FRACTION;
    const scale = freeSum > 0 ? remaining / freeSum : 0;
    fr = fr.map((f, i) => (below[i] ? MIN_TILE_FRACTION : f * scale));
  }
  return fr;
}

/** Reconcile a persisted fraction list to exactly `n` tiles: identity when
 *  already valid (right length + sums to 1 + all positive); otherwise drop
 *  extras / append equal-share entries and renormalize to sum 1 with the floor
 *  enforced. Absent/garbage → an equal split. */
export function reconcileFractions(fr: readonly number[] | undefined, n: number): number[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  if (n === 1) return [1];
  if (fr && isValidFractions(fr, n)) return fr.slice();
  // Salvage whatever positive, finite weights we have; pad short lists with the
  // average of what remains (or an equal share when nothing usable survives).
  const usable = (fr ?? []).filter(
    (f): f is number => typeof f === "number" && Number.isFinite(f) && f > 0,
  );
  const weights: number[] = usable.slice(0, n);
  if (weights.length < n) {
    const fill = weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : 1 / n;
    while (weights.length < n) weights.push(fill);
  }
  return normalizeToFloor(weights);
}

/** Drag divider `i` (the shared edge between tile `i` and tile `i+1`) by
 *  `deltaFrac`: the edge moves, transferring width between the two neighbors
 *  only; every other tile is untouched, the sum stays 1. The move is clamped so
 *  NEITHER neighbor drops below MIN_TILE_FRACTION. Returns a NEW array; the
 *  input is treated as read-only. Out-of-range `i` (or a non-finite delta) →
 *  an unchanged copy. */
export function resizeAtDivider(fr: readonly number[], i: number, deltaFrac: number): number[] {
  const out = fr.slice();
  if (i < 0 || i >= out.length - 1) return out;
  if (typeof deltaFrac !== "number" || !Number.isFinite(deltaFrac)) return out;
  const a = out[i]!;
  const b = out[i + 1]!;
  // Clamp so both neighbors stay ≥ floor: delta ∈ [floor - a, b - floor].
  const lo = MIN_TILE_FRACTION - a;
  const hi = b - MIN_TILE_FRACTION;
  const d = Math.max(lo, Math.min(hi, deltaFrac));
  out[i] = a + d;
  out[i + 1] = b - d;
  return out;
}
