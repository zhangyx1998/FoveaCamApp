// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// SINGLE SOURCE OF TRUTH for the shared ["config"] document's cross-process schema —
// the doc path, value unions, defaults, and clamp bounds both the renderer (@lib/config,
// Vue-bound) and the Vue-free orchestrator readers must agree on. Exists because
// @lib/config imports Vue, so a session-reachable reader can't pull it in. Vue-free AND
// Node-free (types + plain data, zero imports) so any process can load it.
// spec: docs/spec/store.md#config-schema

/** The shared app-config document path. Every reader (renderer `useAppConfig`,
 *  each orchestrator store-hub reader) targets this ONE document, so a Settings
 *  edit and a module drawer edit hit the same doc and broadcast to each other. */
export const APP_CONFIG_PATH: string[] = ["config"];

// --- record compression (RECORDING START; @orchestrator/record-compression) ---

/** The recording-compression methods (extensible union — more may come,
 *  none besides zlib now). "none" = raw uncompressed streams; "zlib" = per-frame
 *  zlib CompressStream (recorder consumes the `/zlib` sibling). */
export const RECORD_COMPRESSIONS = ["none", "zlib"] as const;

/** Recording compression method. Consumed at RECORDING START by the orchestrator
 *  recording facilities; applies to recordings STARTED after a change. */
export type RecordCompression = (typeof RECORD_COMPRESSIONS)[number];

/** Default compression = today's raw uncompressed behavior for every app. */
export const DEFAULT_RECORD_COMPRESSION: RecordCompression = "none";

/** Coerce an untrusted value (config read, wire) to a valid method, falling back
 *  to {@link DEFAULT_RECORD_COMPRESSION}. Shared so the renderer and the
 *  orchestrator validate identically. */
export function coerceRecordCompression(value: unknown): RecordCompression {
  return value === "zlib" ? "zlib" : "none";
}

// --- prediction rate (GLOBAL; @orchestrator/prediction-rate) ------------------
// The native IMM brick's free-running emit rate.

/** Prediction-rate clamp window (Hz). */
export const PREDICTION_RATE_MIN = 60;
export const PREDICTION_RATE_MAX = 1000;

/** Default prediction rate (Hz). Inlined nowhere else — the disparity-scope
 *  drawer's `PREDICTION_RATE_DEFAULT` and the orchestrator reader both import
 *  this one constant. */
export const DEFAULT_PREDICTION_RATE_HZ = 600;

// --- serial-latency compensation (GLOBAL; @orchestrator/serial-latency) -------

/** Serial-latency compensation toggle default = OFF (byte-identical fixed
 *  lookahead behavior until the operator opts in). */
export const DEFAULT_SERIAL_LATENCY_COMP = false;

/** Auto-close a projection window when ALL panes have terminated
 *  (renderer-only consumer). */
export const DEFAULT_PROJECTION_AUTO_CLOSE = true;

// --- profiler hover-card mode (GLOBAL; renderer-only, profiler graph panel) ---
// The profiler node graph's hover-detail card behavior.

/** The profiler hover-card behaviors (extensible union). "follow" = the
 *  card follows the cursor (quadrant-flipped to stay in view); "corner" = the
 *  card snaps to a container corner that does not cover the hovered element. */
export const PROFILER_HOVER_CARD_MODES = ["follow", "corner"] as const;

/** Profiler hover-card mode. Read LIVE by the profiler graph panel over the
 *  shared config doc (same broadcast path as every other entry). */
export type ProfilerHoverCardMode = (typeof PROFILER_HOVER_CARD_MODES)[number];

/** Default hover-card mode = "follow" (the cursor-tracking behavior). */
export const DEFAULT_PROFILER_HOVER_CARD_MODE: ProfilerHoverCardMode = "follow";

/** Coerce an untrusted value (config read, wire) to a valid mode, falling back
 *  to {@link DEFAULT_PROFILER_HOVER_CARD_MODE}. */
export function coerceProfilerHoverCardMode(value: unknown): ProfilerHoverCardMode {
  return value === "corner" ? "corner" : "follow";
}
