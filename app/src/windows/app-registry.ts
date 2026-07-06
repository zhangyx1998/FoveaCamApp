// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// App id → module component loaders for the per-app window shell.
// Dynamic imports keep each entry's initial chunk lean (renderer entries MAY
// share chunks — V11 applies to preloads only). Playground is dev-gated the
// same way App.vue gated it: under `import.meta.env.DEV ? … : {}` the
// production build constant-folds the branch away, so the playground module
// (the last renderer code importing `core` directly) never reaches a
// production bundle — the renderer stays zero-core.

import type { Component } from "vue";

type Loader = () => Promise<{ default: Component }>;

export const appComponents: Record<string, Loader> = {
  "disparity-scope": () => import("@modules/disparity-scope/index.vue"),
  "tracking-single": () => import("@modules/tracking-single/index.vue"),
  "multi-fovea": () => import("@modules/multi-fovea/index.vue"),
  "manual-control": () => import("@modules/manual-control/index.vue"),
  "single-capture": () => import("@modules/single-capture/index.vue"),
  "manage-cameras": () => import("@modules/manage-cameras/index.vue"),
  "calibrate-intrinsic": () => import("@modules/calibrate-intrinsic/index.vue"),
  "calibrate-extrinsic": () => import("@modules/calibrate-extrinsic/index.vue"),
  "calibrate-distortion": () => import("@modules/calibrate-distortion/index.vue"),
  "calibrate-drift": () => import("@modules/calibrate-drift/index.vue"),
  ...(import.meta.env.DEV
    ? { playground: () => import("@modules/playground/index.vue") }
    : {}),
};
