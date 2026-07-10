// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { computed, type WritableComputedRef } from "vue";
import Store from "./store.js";
import { useDefaults } from "./util/index.js";

export interface AppConfig {
  // ---- TeleCanvas (RemoteCanvas.vue) -----------------------------------
  // Destination URL the RemoteCanvas overlay PUTs its projection SVG to.
  // There is NO separate mode flag — an empty/invalid URL simply disables the
  // PUT (RemoteCanvas catches the failed fetch), so "empty = off" is the whole
  // contract. Surfaced verbatim in the config window (the two edit the same
  // `["config"]` document, so they observe each other's writes live).
  tele_canvas_url?: string;
  // ---- Capture / recording destinations --------------------------------
  // Preferred BASE directory captures/recordings default into (a per-namespace
  // subfolder is appended by `SavePath`). Absent/empty = auto (external volume
  // if mounted, else ~/Downloads). Consumed by `@lib/save-path`'s default
  // resolution via `foveaBridge.resolveDefaultSavePath(dir, base)`.
  default_save_dir?: string;
  // ---- Camera layout / calibration geometry ----------------------------
  // Stereo baseline (mm) — disparity-scope seeds its vergence baseline from this
  // at session activate (read-once, so it applies on the NEXT disparity-scope
  // session, not live).
  baseline_distance_mm: number;
  // Calibration marker geometry — LIVE-driving: calibrate-extrinsic and
  // calibrate-drift bind their marker-size / ratio sliders to this same
  // document, so a config-window edit reflects in an open calibrate window
  // immediately (store-hub broadcast), and vice-versa.
  cal_marker_size_mm: number;
  cal_marker_ratio: number;
  // Capture stack depth. NOTE (2026-07-09): this AppConfig key is currently
  // UNUSED — manual-control keeps its own session-local `cap_stack` state, so a
  // value here drives nothing. Deliberately NOT surfaced in the config window
  // ("every setting shown must drive behavior"). Kept for back-compat / callers
  // that may adopt it later.
  cap_stack: number;
}

export const APP_CONFIG_PATH = ["config"] as const;

/** The declared defaults for every AppConfig key — exported so the values are
 *  assertable without a live store (the config window / consumers read them
 *  through the `useDefaults` proxy below). */
export const APP_CONFIG_DEFAULTS: Readonly<AppConfig> = {
  tele_canvas_url: "",
  default_save_dir: "",
  baseline_distance_mm: 200.0,
  cal_marker_size_mm: 60.0,
  cal_marker_ratio: 1.0,
  cap_stack: 5,
};

export async function useAppConfig() {
  return useDefaults<AppConfig>(await Store.open<AppConfig>("config"), APP_CONFIG_DEFAULTS);
}

/**
 * Live, writable ref to ONE app-config key — the "special computed ref" that
 * makes config edits apply across windows without a restart.
 *
 * It is a thin `computed` over the SAME reactive `["config"]` document every
 * other consumer already reads through `useAppConfig()` (`Store.open("config")`
 * is cached per renderer + backed by the orchestrator store-hub). Writing the
 * ref mutates that document, which queues a `store:write`; the store-hub
 * persists it and broadcasts `store:config` to every OTHER window's channel,
 * whose `Store` client applies it onto its own copy in place. So:
 *   - a write here updates consumers in this AND other windows live, and
 *   - a write elsewhere (e.g. calibrate-extrinsic's marker slider, which
 *     v-models the same document) flows back into this ref for free.
 *
 * Defaults come from `useAppConfig()`'s `useDefaults` proxy, so reading a key
 * the document has never stored returns the declared default rather than
 * `undefined`; writing then persists an explicit value.
 */
export async function useConfigRef<K extends keyof AppConfig>(
  key: K,
): Promise<WritableComputedRef<AppConfig[K]>> {
  const config = await useAppConfig();
  return configRef(config, key);
}

/**
 * The pure core of `useConfigRef`, split out so it is unit-testable with any
 * reactive `AppConfig`-shaped object (no orchestrator connection needed). A
 * writable `computed` reads/writes `config[key]` directly — because `config`
 * is reactive, two refs over the same object (and any template depending on it)
 * stay in lockstep, which is exactly the in-window half of cross-window apply.
 */
export function configRef<T extends Record<string, any>, K extends keyof T>(
  config: T,
  key: K,
): WritableComputedRef<T[K]> {
  return computed<T[K]>({
    get() {
      return config[key];
    },
    set(value) {
      config[key] = value;
    },
  });
}
