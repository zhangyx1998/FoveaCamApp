// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// Session → debugger-component registry (WS2 2b). Maps an orchestrator session
// name to the module's OWN debugger component (loaded lazily), which the debug
// sub-window mounts full-window. Mirrors `app-registry`'s id→loader pattern; a
// module gains a debug sub-window purely by adding a `Debugger.vue` alongside
// its main component and registering its loader here (no window-framework
// changes). The component owns its own passive contract/pipe subscriptions —
// the window shell is contract-agnostic.

import type { Component } from "vue";

type Loader = () => Promise<{ default: Component }>;

const debugLoaders: Record<string, Loader> = {
  "disparity-scope": () => import("@modules/disparity-scope/Debugger.vue"),
};

export function debugLoaderFor(session: string): Loader | null {
  return debugLoaders[session] ?? null;
}
