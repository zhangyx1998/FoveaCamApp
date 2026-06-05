// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { computed, type Ref, type WritableComputedRef } from "vue";
import { deg, rad } from "./util/math";

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
