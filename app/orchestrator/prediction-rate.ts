// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The GLOBAL prediction-rate setting, orchestrator side (docs/proposals/
// prediction-compose-node.md — ruling 2). ONE app-wide key `prediction_rate_hz`
// (default 600, clamped 60..1000) that drives the native IMM brick's free-
// running emit rate. Edited from BOTH Settings → Global config AND the
// disparity-scope drawer slider — they write the SAME `["config"]` document, so
// the session subscribes here and live-applies via `imm.setParams({ rateHz })`.
//
// Vue-free (store-hub read/subscribe), mirroring `anaglyph-style.ts` — this
// module is imported by a session, so it must not pull `@lib/config` (which
// touches Vue). The default + clamp bounds are duplicated in `@lib/config`'s
// AppConfig defaults for the renderer; keep the two in sync.

import { read, subscribe } from "./store-hub.js";

/** The shared app config doc path (mirrors `APP_CONFIG_PATH` in `@lib/config`). */
export const PREDICTION_RATE_CONFIG_PATH = ["config"];

/** Prediction-rate window (proposal ruling 2). */
export const PREDICTION_RATE_MIN = 60;
export const PREDICTION_RATE_MAX = 1000;
export const DEFAULT_PREDICTION_RATE_HZ = 600;

/** Clamp any value to the ruled window; a non-finite/unset value falls back to
 *  the default (a config hiccup must never wedge the predictor). */
export function clampPredictionRateHz(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PREDICTION_RATE_HZ;
  return Math.min(PREDICTION_RATE_MAX, Math.max(PREDICTION_RATE_MIN, Math.round(n)));
}

/** Read the configured prediction rate (store-hub cache), clamped. */
export async function readPredictionRateHz(): Promise<number> {
  try {
    const cfg = await read<{ prediction_rate_hz?: unknown }>(
      PREDICTION_RATE_CONFIG_PATH,
      {},
    );
    return clampPredictionRateHz(
      cfg.prediction_rate_hz ?? DEFAULT_PREDICTION_RATE_HZ,
    );
  } catch {
    return DEFAULT_PREDICTION_RATE_HZ;
  }
}

/** Subscribe to LIVE prediction-rate changes (store-hub broadcast). `cb` fires
 *  only when the clamped rate actually CHANGES from `initial` (an unrelated
 *  config write re-broadcasts the whole doc). Returns an unsubscribe; pair with
 *  {@link readPredictionRateHz} and pass its value as `initial`. */
export function subscribePredictionRateHz(
  cb: (rateHz: number) => void,
  initial: number | null = null,
): () => void {
  let last = initial;
  return subscribe(PREDICTION_RATE_CONFIG_PATH, (value) => {
    const rate = clampPredictionRateHz(
      (value as { prediction_rate_hz?: unknown } | undefined)
        ?.prediction_rate_hz ?? DEFAULT_PREDICTION_RATE_HZ,
    );
    if (rate === last) return;
    last = rate;
    cb(rate);
  });
}
