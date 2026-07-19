// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Serial-latency compensation for the motion predictor: adds an adaptive one-way
// estimate serialLatencyMs = EMA(ackRttMs.p50)/2 to the fixed delay_compensation_ms
// lookahead; the disparity-scope session polls it and pushes imm.setParams({ delayMs }).
// Gated by the GLOBAL serial_latency_comp key (default OFF); off / no controller / no
// RTT samples = byte-identical fixed behavior. Vue-free; EMA is a pure unit-tested class.
// spec: docs/spec/controller.md#serial-latency

import { read, subscribe } from "./store-hub.js";
import { APP_CONFIG_PATH, DEFAULT_SERIAL_LATENCY_COMP } from "@lib/config-schema";

/** The shared app config doc path (re-export of `@lib/config-schema`'s
 *  `APP_CONFIG_PATH` under this reader's historical name). */
export const SERIAL_LATENCY_CONFIG_PATH = APP_CONFIG_PATH;

/** EMA smoothing factor per sample (stats-cadence samples, ~2 Hz): ~0.25
 *  reaches ~63% of a step in ~4 samples (~2 s) — fast enough to track queue
 *  pressure, slow enough that RTT jitter never whips the predictor. */
export const SERIAL_LATENCY_EMA_ALPHA = 0.25;

/** RTT samples above this are TRANSPORT HICCUPS, not steady-state latency:
 *  a single multi-hundred-ms p50 (USB
 *  re-enumeration, a wedged read) would take many EMA steps to wash out and
 *  meanwhile inflate the predictor's lookahead. Discarded like the existing
 *  non-finite hiccup guard. */
export const RTT_SAMPLE_CEILING_MS = 250;

/** Hard cap on the TOTAL applied lookahead (fixed + adaptive), ms — the
 *  runaway-lookahead guard: congestion grows RTT, an uncapped
 *  lookahead grows per-tick deltas, which defeat the sink dedupe and feed the
 *  congestion back. 50 ms ≈ 3 camera frames of lead — beyond that the
 *  extrapolation is doing more harm than the latency it hides. */
export const MAX_TOTAL_LOOKAHEAD_MS = 50;

/** Clamp the total lookahead the session pushes into `imm.setParams` —
 *  pure, unit-tested; the fixed (per-triple) component passes through
 *  untouched below the cap. Non-finite degrades to 0 (never poison the
 *  predictor's delay). */
export function clampLookaheadMs(totalMs: number): number {
  if (!Number.isFinite(totalMs)) return 0;
  return Math.min(totalMs, MAX_TOTAL_LOOKAHEAD_MS);
}

/** Pure EMA over ACK-RTT p50 samples → the one-way serial latency estimate.
 *  `value` is null until the first sample (no samples = fixed behavior). */
export class SerialLatencyEstimator {
  private ema: number | null = null;

  constructor(private readonly alpha = SERIAL_LATENCY_EMA_ALPHA) {}

  /** Feed one ackRttMs.p50 sample (ms). Non-finite/negative samples are
   *  ignored (a probe hiccup must never poison the estimate), and so are
   *  samples above {@link RTT_SAMPLE_CEILING_MS} — a transport hiccup is a
   *  discrete event, not a latency to lead by. */
  push(rttP50Ms: number): void {
    if (!Number.isFinite(rttP50Ms) || rttP50Ms < 0) return;
    if (rttP50Ms > RTT_SAMPLE_CEILING_MS) return;
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

// --- applied-lookahead bus ---------------------------------
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
