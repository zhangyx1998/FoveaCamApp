// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// Session → debug-overlay registry (WS2 2b). Maps an orchestrator session name
// to the module's annotation-overlay component + the contract the debug window
// subscribes to for it. Mirrors `app-registry`'s id→loader pattern; a module
// gains a debug sub-window purely by extracting its overlay into a component
// and registering it here (no window-framework changes).

import type { Component } from "vue";
import type { Contract } from "@lib/orchestrator/protocol";
import { tracking } from "@modules/tracking-single/contract";
import TrackingAnnotations from "@modules/tracking-single/TrackingAnnotations.vue";

export interface DebugOverlay {
  /** The real module contract the debug window passively subscribes to. */
  contract: Contract;
  /** Component that draws the SVG overlay from that session's telemetry. */
  component: Component;
}

export const DEBUG_OVERLAYS: Record<string, DebugOverlay> = {
  tracking: { contract: tracking, component: TrackingAnnotations },
};

export function debugOverlayFor(session: string): DebugOverlay | null {
  return DEBUG_OVERLAYS[session] ?? null;
}
