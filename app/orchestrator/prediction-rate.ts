// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The GLOBAL prediction-rate setting, orchestrator side: one app-wide key
// prediction_rate_hz (default 600, clamped 60..1000) driving the native IMM brick's
// free-running emit rate. Edited from both Settings and the disparity-scope slider (same
// ["config"] doc); the session subscribes here and live-applies imm.setParams({ rateHz }).
// Vue-free (store-hub, mirroring anaglyph-style); path/default/clamp come from the shared
// @lib/config-schema constants so renderer and this reader can't drift.
// spec: docs/spec/controller.md#prediction-rate

import { read, subscribe } from "./store-hub.js";
import {
  APP_CONFIG_PATH,
  DEFAULT_PREDICTION_RATE_HZ,
  PREDICTION_RATE_MAX,
  PREDICTION_RATE_MIN,
} from "@lib/config-schema";

export { APP_CONFIG_PATH, DEFAULT_PREDICTION_RATE_HZ, PREDICTION_RATE_MAX, PREDICTION_RATE_MIN };

/** The shared app config doc path (re-export of `@lib/config-schema`'s
 *  `APP_CONFIG_PATH` under this reader's historical name). */
export const PREDICTION_RATE_CONFIG_PATH = APP_CONFIG_PATH;

/** Clamp any value to the allowed window; a non-finite/unset value falls back to
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
