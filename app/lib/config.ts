// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { computed, type WritableComputedRef } from "vue";
import Store from "./store.js";
import { useDefaults } from "./util/index.js";
import { DEFAULT_TELECANVAS_PORT, type TeleCanvasMode } from "./telecanvas.js";
import {
  DEFAULT_ANAGLYPH_STYLE,
  type AnaglyphStyle,
} from "../../docs/schema/anaglyph.js";
import {
  APP_CONFIG_PATH,
  DEFAULT_PREDICTION_RATE_HZ,
  DEFAULT_PROFILER_HOVER_CARD_MODE,
  DEFAULT_PROJECTION_AUTO_CLOSE,
  DEFAULT_RECORD_COMPRESSION,
  DEFAULT_SERIAL_LATENCY_COMP,
  type ProfilerHoverCardMode,
  type RecordCompression,
} from "./config-schema.js";

// The cross-process config SCHEMA — doc path, value unions, defaults, clamp
// bounds — now lives in the Vue-free `./config-schema` so the orchestrator
// readers can share it without importing this Vue-touching module.
// Re-exported here so existing `@lib/config` consumers keep the same import
// surface.
export { APP_CONFIG_PATH };
export type { RecordCompression };

export interface AppConfig {
  // ---- TeleCanvas (standalone dual-mode module) ------------------------
  // `client` (default) — PUT the merged projection SVG to a REMOTE TeleCanvas
  // server (`tele_canvas_url`; empty/invalid = disabled, the app catches the
  // failed PUT). `host` — the app spins up its OWN TeleCanvas server on
  // `tele_canvas_port` and the push targets `http://127.0.0.1:<port>/`. The
  // mode default preserves the historical "empty URL = off" behavior. All three
  // are surfaced in the Settings window AND the TeleCanvas window; they edit the
  // same `["config"]` document, so writes apply live across windows.
  tele_canvas_mode?: TeleCanvasMode;
  tele_canvas_url?: string;
  tele_canvas_port: number;
  // ---- Capture / recording destinations --------------------------------
  // Preferred BASE directory captures/recordings default into (a per-namespace
  // subfolder is appended by `SavePath`). Absent/empty = auto (external volume
  // if mounted, else ~/Downloads). Consumed by `@lib/save-path`'s default
  // resolution via `foveaBridge.resolveDefaultSavePath(dir, base)`.
  default_save_dir?: string;
  // Recording compression method (default "none"). Read at RECORDING START by
  // the orchestrator recording facilities (store-hub, same pattern as the
  // calibrate-extrinsic marker sizes) → applies to recordings STARTED after the
  // change; running recordings keep the method they started with. "none" =
  // today's raw uncompressed streams for every app. "zlib" = the generic
  // recording facility (@orchestrator/raw-recording — disparity-scope + the four
  // calibrate wizards) routes ALL its raw streams through the per-frame zlib
  // CompressStream brick (the recorder consumes the `/zlib` sibling); multi-fovea
  // keeps its own composition and its per-stream toggles gate WHICH streams use
  // this method (disabled under "none"). On-disk contract unchanged: compressed
  // streams carry the `/zlib` pixelFormat suffix, so the viewer/pyfcap decode is
  // untouched. NOTE (verify on hardware): lossless zlib may not hold full-rate
  // 12p on all three cameras — drops attribute honestly in the RecordButton hover.
  record_compression?: RecordCompression;
  // ---- Camera layout / calibration geometry ----------------------------
  // Stereo baseline (mm) — LEGACY FALLBACK ONLY. The baseline is a per-TRIPLE
  // setting (`baseline_mm` in the
  // `["triples", <hash>]` doc); this app-level value is only consumed as the
  // fallback when a triple has no `baseline_mm` (see `@lib/calibration-data`'s
  // `resolveBaseline`). NOT surfaced in the Settings App section anymore — the
  // baseline field lives in the per-triple section. Kept (with its 200 default)
  // so existing rigs keep behavior with zero migration.
  baseline_distance_mm: number;
  // Calibration marker geometry — LIVE-driving: calibrate-extrinsic and
  // calibrate-drift bind their marker-size / ratio sliders to this same
  // document, so a config-window edit reflects in an open calibrate window
  // immediately (store-hub broadcast), and vice-versa.
  cal_marker_size_mm: number;
  cal_marker_ratio: number;
  // Anaglyph style — the left-eye/right-eye color
  // arrangement for EVERY anaglyph surface: the disparity-scope center "Anaglyph"
  // view AND the standalone viewer's 3D mode. Written as "<left><right>": R = red,
  // B = blue, C = cyan. Default "RC" = the historical red-left / cyan-right. The
  // style→channel mapping is the shared `docs/schema/anaglyph` table (one source
  // of truth for the cards, the viewer compose, and the native CompositeStream
  // brick). Applies LIVE: the disparity session watches this doc and retunes the
  // composite brick without reconnect; the viewer recomposes on the next frame.
  anaglyph_style?: AnaglyphStyle;
  // Capture stack depth. NOTE: this AppConfig key is currently
  // UNUSED — manual-control keeps its own session-local `cap_stack` state, so a
  // value here drives nothing. Deliberately NOT surfaced in the config window
  // ("every setting shown must drive behavior"). Kept for back-compat / callers
  // that may adopt it later.
  cap_stack: number;
  // Prediction rate (Hz) — GLOBAL setting driving the native IMM motion-
  // predictor brick's free-running emit rate. Default 600, clamped 60..1000.
  // Edited from BOTH Settings
  // → Global config AND the disparity-scope drawer slider (same key), and
  // live-applied by the disparity-scope session via `imm.setParams({ rateHz })`
  // — no reconnect. The default + clamp bounds are the shared `@lib/config-schema`
  // constants (`DEFAULT_PREDICTION_RATE_HZ`, `PREDICTION_RATE_MIN/MAX`), which the
  // Vue-free `@orchestrator/prediction-rate` reader imports too (single source).
  prediction_rate_hz?: number;
  // Serial-latency compensation in the motion predictor. ON: the
  // disparity-scope session
  // adds a MEASURED one-way serial latency (EMA of the ACK-RTT p50 / 2) to
  // the per-triple fixed `delay_compensation_ms` lookahead, live-applied via
  // `imm.setParams`. OFF (default) / no controller / no RTT samples =
  // byte-identical fixed behavior. Settings → Global config only (no drawer
  // control). Orchestrator-side twin: `@orchestrator/serial-latency`.
  serial_latency_comp?: boolean;
  // ---- Viewer video export ---------------------------------------------
  // Global PARALLEL-export toggle. false (default) = new exports QUEUE and
  // dispatch after the current one finishes; true = run concurrently. Persisted
  // like every other viewer/app option; the viewer window pushes it to its
  // playback engine (the queue's dispatch policy) on change + at spawn.
  export_parallel?: boolean;
  // ---- Projection split view -------------------------------------------
  // Auto-close a projection window when ALL its panes have TERMINATED (their
  // sources didn't reappear within the rebind grace, ~10 s). Default TRUE.
  // A pane frozen by a mere app-switch handoff rebinds and never counts, so a
  // default-on auto-close doesn't erase projections on every switch — only a
  // window whose every source is truly gone closes itself.
  projection_auto_close?: boolean;
  // ---- Profiler node graph ---------------------------------------------
  // Hover-detail card behavior for the profiler's pipeline graph. "follow"
  // (default) — the card tracks the cursor, quadrant-flipped so it never
  // overflows the graph container. "corner" — the card snaps to a container
  // corner that does not cover the hovered node/edge. Renderer-only; the
  // profiler window (its own BrowserWindow) reads it live over this shared doc.
  profiler_hover_card?: ProfilerHoverCardMode;
}

/** The declared defaults for every AppConfig key — exported so the values are
 *  assertable without a live store (the config window / consumers read them
 *  through the `useDefaults` proxy below). */
export const APP_CONFIG_DEFAULTS: Readonly<AppConfig> = {
  tele_canvas_mode: "client",
  tele_canvas_url: "",
  tele_canvas_port: DEFAULT_TELECANVAS_PORT,
  default_save_dir: "",
  record_compression: DEFAULT_RECORD_COMPRESSION,
  baseline_distance_mm: 200.0,
  cal_marker_size_mm: 60.0,
  cal_marker_ratio: 1.0,
  anaglyph_style: DEFAULT_ANAGLYPH_STYLE,
  cap_stack: 5,
  prediction_rate_hz: DEFAULT_PREDICTION_RATE_HZ,
  serial_latency_comp: DEFAULT_SERIAL_LATENCY_COMP,
  export_parallel: false,
  projection_auto_close: DEFAULT_PROJECTION_AUTO_CLOSE,
  profiler_hover_card: DEFAULT_PROFILER_HOVER_CARD_MODE,
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
 * is cached per renderer + backed by MAIN, the single config authority —
 * config-store-main-authority.md). Writing the ref mutates that document, which
 * queues a key-level PATCH to main; main persists it and broadcasts the merged
 * value to every OTHER window (and orchestrator instance), whose `Store` client
 * applies it onto its own copy in place. So:
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
