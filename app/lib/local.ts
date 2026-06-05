/* ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 * ------------------------------------------------------ */

import { nextTick, ref, watch, type Ref } from "vue";

export type Local<T> = Ref<T> & {
  /** The default value (used when no value is persisted, and by `reset`). */
  readonly default: T;
  /** Clear the persisted value and revert to the default. */
  reset: () => void;
};

export default function local<T>(key: string, default_value: T): Local<T> {
  const v = ref<T>(default_value) as any as Local<T>;
  const item = localStorage.getItem(key);
  try {
    if (item !== null) v.value = JSON.parse(item) as T;
  } catch {
    localStorage.removeItem(key);
  }
  let muted = false;
  watch(
    v,
    (new_value) => {
      if (!muted) localStorage.setItem(key, JSON.stringify(new_value));
    },
    { deep: true },
  );
  Object.defineProperty(v, "default", {
    get: () => default_value,
    enumerable: false,
  });
  v.reset = () => {
    // Mute persistence across the value change so the cleared key isn't
    // immediately rewritten with the default by the watcher.
    muted = true;
    v.value = default_value;
    nextTick(() => {
      localStorage.removeItem(key);
      muted = false;
    });
  };
  return v;
}
