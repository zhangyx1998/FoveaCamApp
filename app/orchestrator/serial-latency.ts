// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Serial-latency compensation for the motion predictor (docs/proposals/
// serial-rate-governor.md Part 4, ruling addendum 2026-07-10). The per-triple
// `delay_compensation_ms` is a FIXED lookahead; the serial hop's contribution
// varies with queue depth / host load — with the wave-6 pressure sensors it
// becomes adaptive: `serialLatencyMs = EMA(ackRttMs.p50) / 2` (one-way ≈ half
// the ACK round trip; EMA smoothing so RTT jitter never whips the predictor).
// The disparity-scope session polls the estimate at its stats throttle and
// pushes `imm.setParams({ delayMs: fixed + (enabled ? latency : 0) })`.
//
// Gated by the GLOBAL `serial_latency_comp` config key (default OFF, Settings
// → Global config only — no drawer control, per ruling). Off / no controller
// / no RTT samples yet = byte-identical fixed behavior.
//
// Vue-free (store-hub read/subscribe — the anaglyph-style/prediction-rate
// precedent); the EMA is a pure class, unit-tested in vitest.

import { read, subscribe } from "./store-hub.js";
import { APP_CONFIG_PATH, DEFAULT_SERIAL_LATENCY_COMP } from "@lib/config-schema";

/** The shared app config doc path (re-export of `@lib/config-schema`'s
 *  `APP_CONFIG_PATH` under this reader's historical name). */
export const SERIAL_LATENCY_CONFIG_PATH = APP_CONFIG_PATH;

/** EMA smoothing factor per sample (stats-cadence samples, ~2 Hz): ~0.25
 *  reaches ~63% of a step in ~4 samples (~2 s) — fast enough to track queue
 *  pressure, slow enough that RTT jitter never whips the predictor. */
export const SERIAL_LATENCY_EMA_ALPHA = 0.25;

/** Pure EMA over ACK-RTT p50 samples → the one-way serial latency estimate.
 *  `value` is null until the first sample (no samples = fixed behavior). */
export class SerialLatencyEstimator {
  private ema: number | null = null;

  constructor(private readonly alpha = SERIAL_LATENCY_EMA_ALPHA) {}

  /** Feed one ackRttMs.p50 sample (ms). Non-finite/negative samples are
   *  ignored (a probe hiccup must never poison the estimate). */
  push(rttP50Ms: number): void {
    if (!Number.isFinite(rttP50Ms) || rttP50Ms < 0) return;
    this.ema =
      this.ema === null
        ? rttP50Ms
        : this.ema + this.alpha * (rttP50Ms - this.ema);
  }

  /** One-way serial latency (ms) = EMA(RTT p50) / 2, or null before the
   *  first sample. */
  get latencyMs(): number | null {
    return this.ema === null ? null : this.ema / 2;
  }

  reset(): void {
    this.ema = null;
  }
}

function coerce(value: unknown): boolean {
  const v = (value as { serial_latency_comp?: unknown } | undefined)
    ?.serial_latency_comp;
  return typeof v === "boolean" ? v : DEFAULT_SERIAL_LATENCY_COMP;
}

/** Read the `serial_latency_comp` toggle (default OFF; a read fault degrades
 *  to the schema default — the fixed lookahead must never break on a config
 *  hiccup). */
export async function readSerialLatencyComp(): Promise<boolean> {
  try {
    return coerce(await read<Record<string, unknown>>(SERIAL_LATENCY_CONFIG_PATH, {}));
  } catch {
    return DEFAULT_SERIAL_LATENCY_COMP;
  }
}

/** Subscribe to LIVE toggle changes (store-hub broadcast; dedupes from
 *  `initial`). Returns an unsubscribe. */
export function subscribeSerialLatencyComp(
  cb: (enabled: boolean) => void,
  initial: boolean | null = null,
): () => void {
  let last = initial;
  return subscribe(SERIAL_LATENCY_CONFIG_PATH, (value) => {
    const enabled = coerce(value);
    if (enabled === last) return;
    last = enabled;
    cb(enabled);
  });
}

// --- applied-lookahead bus (Part 4 telemetry) ---------------------------------
// The predictor's APPLIED total lookahead (fixed + live) must join the
// controller/serial-pressure telemetry (the profiler shows what the predictor
// actually leads by), but the estimate lives in the disparity-scope session.
// ONE process-local mutable cell bridges the two sessions — the disparity
// session writes on every setParams push; the controller session's probe
// timer reads it into its telemetry. Null = no predictor session active.
let appliedLookaheadMs: number | null = null;

export function publishAppliedLookahead(ms: number | null): void {
  appliedLookaheadMs = ms;
}

export function currentAppliedLookahead(): number | null {
  return appliedLookaheadMs;
}
