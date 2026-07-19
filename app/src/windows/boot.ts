// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared per-window boot glue for the multi-entry renderer build. Each entry HTML's script calls
// `bootWindow()` with its root component — global listeners that every
// window class wants live here, once, instead of per-entry copies.

import { createApp, type Component } from "vue";
import "../index.css";

export function bootWindow(
  root: Component,
  rootProps?: Record<string, unknown>,
): void {
  createApp(root, rootProps).mount("#app");

  // Prevent global zooming on macOS (ported from the legacy src/index.ts).
  document.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) e.preventDefault();
    },
    { passive: false },
  );
}
