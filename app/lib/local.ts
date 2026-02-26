/* ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 * ------------------------------------------------------ */

import { ref, watch } from "vue";

export default function local<T>(
    key: string,
    default_value: T,
) {
    const v = ref<T>(default_value);
    const item = localStorage.getItem(key);
    try {
        if (item !== null) v.value = JSON.parse(item) as T;
    } catch {
        localStorage.removeItem(key);
    }
    watch(v, (new_value) => {
        localStorage.setItem(key, JSON.stringify(new_value));
    }, { deep: true });
    return v;
}

export type Local<T> = ReturnType<typeof local<T>>;
