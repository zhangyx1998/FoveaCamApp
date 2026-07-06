// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { PropType, ref, watchEffect, type Ref } from "vue";

export function NoCheck<T>() {
  return null as unknown as PropType<T>;
}

/** A `computed`-like ref for async sources (e.g. an IPC round-trip through
 *  `foveaBridge`): re-evaluates whenever a reactive dependency read inside
 *  `source` changes, and discards any resolution that isn't from the latest
 *  call — e.g. validating path A, then B before A resolves, must not let A's
 *  late answer clobber B's. `initial` is shown while the first call is in
 *  flight. */
export function useAsyncComputed<T>(
  source: () => Promise<T>,
  initial: T,
): Readonly<Ref<T>> {
  const result = ref(initial) as Ref<T>;
  let token = 0;
  watchEffect(() => {
    const mine = ++token;
    source().then((v) => {
      if (mine === token) result.value = v;
    });
  });
  return result;
}
