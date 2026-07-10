// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// RENDERER-ONLY composable: the LIVE per-triple stereo baseline (mm) for the
// calibrate-* marker overlays (Ruling A, 2026-07-09 per-triplet-settings wave).
//
// The session publishes the leased triple's config store path (`configPath`);
// this opens that same `["triples", <hash>]` document reactively via the store
// client (`Store.open`) — so a Settings-window edit to the triple's
// `baseline_mm` broadcasts through the store-hub and reflects in the open
// calibration window's marker spacing live, and app-level `baseline_distance_mm`
// edits reflect too (the app config is reactive). The resolution order itself
// lives in the SHARED, Vue-free `resolveBaseline` (triple > legacy app > 200),
// so the renderers and the orchestrator agree on the number by construction.
//
// Vue-importing → renderer-only. Do NOT import from a `session.ts` (that would
// bundle Vue into the utility process).

import { computed, ref, watch, type ComputedRef } from "vue";
import Store from "./store.js";
import { resolveBaseline, type TripleConfig } from "./calibration-data.js";
import type { AppConfig } from "./config.js";

/**
 * A live `computed<number>` of the resolved baseline (mm) for the triple at
 * `configPath` (the session-published store path). Before a triple is leased —
 * or when the path is empty — the triple doc is null and the resolution falls
 * back to the legacy app-level `baseline_distance_mm`, else 200.
 *
 * @param configPath reactive getter for the session's `state.configPath`
 *   (`["triples", <hash>]`, or an empty array pre-lease).
 * @param appConfig the reactive `useAppConfig()` object (the legacy fallback).
 */
export function useTripleBaseline(
  configPath: () => readonly string[] | undefined,
  appConfig: Pick<AppConfig, "baseline_distance_mm">,
): ComputedRef<number> {
  const doc = ref<TripleConfig | null>(null);
  watch(
    configPath,
    async (path) => {
      doc.value = path && path.length ? await Store.open<TripleConfig>([...path]) : null;
    },
    { immediate: true },
  );
  return computed(() => resolveBaseline(doc.value?.baseline_mm, appConfig.baseline_distance_mm));
}
