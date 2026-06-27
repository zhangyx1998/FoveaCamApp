// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { computed, type Ref, type WritableComputedRef } from "vue";
import { deg, rad } from "./util/math";
import { clamp } from "./util";

export type LogScale = {
  /** Map a value on the log scale to a linear `[0, 1]` slider ratio. */
  toRatio(value: number): number;
  /** Map a linear `[0, 1]` slider ratio back to a value on the log scale. */
  fromRatio(ratio: number): number;
};

/**
 * Bidirectional mapping between a value on a logarithmic scale `[min, max]` and
 * a linear `[0, 1]` slider ratio, so each step of slider travel multiplies the
 * value by a constant factor (the natural feel for gains, timeouts, etc.).
 *
 * @param min Value at ratio 0 (must be > 0).
 * @param max Value at ratio 1.
 * @param opts.infinityAt When set, ratio 1 maps to this sentinel value (e.g. 0
 *   meaning "no limit") instead of `max`, and any value ≤ 0 / `Infinity` maps
 *   back to ratio 1.
 * @param opts.round Round `fromRatio` to the nearest integer (for ms, px, …).
 */
export function logScale(
  min: number,
  max: number,
  opts: { infinityAt?: number; round?: boolean } = {},
): LogScale {
  const { infinityAt, round = false } = opts;
  const span = Math.log(max / min);
  return {
    toRatio(value) {
      if (infinityAt !== undefined && (!(value > 0) || value === Infinity))
        return 1;
      return clamp(Math.log(value / min) / span, [0, 1]);
    },
    fromRatio(ratio) {
      if (infinityAt !== undefined && ratio >= 1) return infinityAt;
      const value = min * Math.pow(max / min, ratio);
      return round ? Math.round(value) : value;
    },
  };
}

/**
 * Bidirectional reactive conversion between radians (Ref) and degrees (Computed).
 */
export function rad2deg(val: Ref<number>): WritableComputedRef<number> {
  return computed({
    get: () => deg(val.value),
    set: (v) => (val.value = rad(v)),
  });
}

/**
 * Bidirectional reactive conversion between degrees (Ref) and radians (Computed).
 */
export function deg2rad(val: Ref<number>): WritableComputedRef<number> {
  return computed({
    get: () => rad(val.value),
    set: (v) => (val.value = deg(v)),
  });
}
