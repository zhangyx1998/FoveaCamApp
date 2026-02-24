// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { PropType } from "vue";

export function NoCheck<T>() {
  return null as unknown as PropType<T>;
}
