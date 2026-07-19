// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Unified time: THE time origin is the orchestrator's steady clock (process.hrtime.bigint,
// integer ns, monotonic). Every other clock maps INTO host-ns via a calibrated offset
// estimated with the MIN-FILTER (one-sided latency noise → the min over N converges on the
// true offset, PTP's trick). Consumers call toHostNs(clock, ts), never raw device time.
// Caveat: hrtime PAUSES during system sleep — sleepDetected() invalidates calibration on a jump.
// spec: docs/spec/orchestrator-runtime.md#time-align

import type { Camera } from "core/Aravis";

export type ClockId = `camera:${string}` | "controller";

/** One measurement: the subject clock read `subjectNs`, bracketed by host
 *  reads (`midNs` = bracket midpoint, `rttNs` = bracket width). Pull-style
 *  samples (no bracket) use `rttNs: 0n` and one-sided arrival time. */
export interface OffsetSample {
  midNs: bigint;
  rttNs: bigint;
  subjectNs: bigint;
}

export interface ClockCalibration {
  offsetNs: bigint; // hostNs = subjectNs + offsetNs
  /** Spread of candidate offsets (p90 − min) — the confidence number. */
  jitterNs: bigint;
  samples: number;
  method: "latch" | "pull" | "ping" | "manual";
  /** Host-ns when this calibration was taken. */
  atNs: bigint;
  /** Stability: offset drift vs the PREVIOUS calibration of the same clock,
   *  in parts-per-million (set by `setCalibration`; absent on the first
   *  run). Updated on every mid-task re-calibration. */
  driftPpm?: number;
}

// THE host clock. Default = hrtime (tests, pre-boot); the orchestrator boot
// swaps in core's `steadyNowNs` (the NATIVE steady clock is
// the single time authority — hrtime and libc++ steady_clock are not
// guaranteed the same Darwin clock domain, and every owner-applied timestamp
// lives in the native domain).
let hostClock: () => bigint = () => process.hrtime.bigint();
export const hostNowNs = (): bigint => hostClock();
/** Boot-time delegation to the native authority (index.ts). Re-anchors the
 *  wall-label pair — the old anchor's steady half would otherwise be in a
 *  different clock domain than every later `hostNowNs()` reading. */
export function setHostClock(clock: () => bigint): void {
  hostClock = clock;
  bootAnchor.hrtimeNs = clock();
  bootAnchor.epochMs = Date.now();
}

/** Boot anchor pairing the steady origin with wall time — for LABELING only
 *  (exports, logs); never for measurement. Re-anchored by `setHostClock`
 *  when the native authority takes over. */
export const bootAnchor = {
  hrtimeNs: hostNowNs(),
  epochMs: Date.now(),
};

/** Wall-clock label for a host-ns instant (export/README timestamps). */
export function hostNsToEpochMs(hostNs: bigint): number {
  return bootAnchor.epochMs + Number((hostNs - bootAnchor.hrtimeNs) / 1_000_000n);
}

/** Estimator: pick the sample with the smallest bracket (min RTT — the
 *  least latency-contaminated observation); offset = its midpoint − subject.
 *  Jitter = p90 − min over all candidate offsets. Pure. */
export function estimateOffsetNs(samples: OffsetSample[]): {
  offsetNs: bigint;
  jitterNs: bigint;
} {
  if (samples.length === 0) throw new Error("estimateOffsetNs: no samples");
  let best = samples[0]!;
  for (const s of samples) if (s.rttNs < best.rttNs) best = s;
  const offsets = samples
    .map((s) => s.midNs - s.subjectNs)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const min = offsets[0]!;
  const p90 = offsets[Math.min(offsets.length - 1, Math.floor(offsets.length * 0.9))]!;
  return { offsetNs: best.midNs - best.subjectNs, jitterNs: p90 - min };
}

/** One-sided variant for pull-style samples (arrival − subject; no bracket):
 *  the MINIMUM delta is the least-delayed observation. Pure. */
export function estimateOffsetOneSidedNs(samples: OffsetSample[]): {
  offsetNs: bigint;
  jitterNs: bigint;
} {
  if (samples.length === 0) throw new Error("estimateOffsetOneSidedNs: no samples");
  const offsets = samples
    .map((s) => s.midNs - s.subjectNs)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const min = offsets[0]!;
  const p90 = offsets[Math.min(offsets.length - 1, Math.floor(offsets.length * 0.9))]!;
  return { offsetNs: min, jitterNs: p90 - min };
}

// ---- calibration registry --------------------------------------------------

const calibrations = new Map<ClockId, ClockCalibration>();

export function setCalibration(clock: ClockId, cal: ClockCalibration): void {
  // Stability metric: drift vs the previous calibration of the same clock —
  // refreshed on every mid-task re-calibration.
  const prev = calibrations.get(clock);
  if (prev && cal.atNs > prev.atNs && cal.driftPpm === undefined) {
    const dOffset = Number(cal.offsetNs - prev.offsetNs);
    const dTime = Number(cal.atNs - prev.atNs);
    calibrations.set(clock, { ...cal, driftPpm: (dOffset / dTime) * 1e6 });
    return;
  }
  calibrations.set(clock, cal);
}
export function calibration(clock: ClockId): ClockCalibration | null {
  return calibrations.get(clock) ?? null;
}
export function clearCalibrations(): void {
  calibrations.clear();
}
/** Snapshot for telemetry/profiler (clock-health panel), incl. the
 *  owner-reported stability metrics (ageNs since calibration, driftPpm). */
export function calibrationsSnapshot(): Record<
  string,
  {
    offsetNs: string;
    jitterNs: string;
    samples: number;
    method: string;
    ageNs: string;
    driftPpm?: number;
  }
> {
  const now = hostNowNs();
  const out: ReturnType<typeof calibrationsSnapshot> = {};
  for (const [id, c] of calibrations)
    out[id] = {
      offsetNs: c.offsetNs.toString(),
      jitterNs: c.jitterNs.toString(),
      samples: c.samples,
      method: c.method,
      ageNs: (now - c.atNs).toString(),
      ...(c.driftPpm !== undefined ? { driftPpm: c.driftPpm } : {}),
    };
  return out;
}

/** Map a subject-clock timestamp onto host steady ns. Throws when the clock
 *  has not been calibrated — callers must not silently mix time bases. */
export function toHostNs(clock: ClockId, subjectNs: bigint): bigint {
  const cal = calibrations.get(clock);
  if (!cal) throw new Error(`toHostNs: clock not calibrated: ${clock}`);
  return subjectNs + cal.offsetNs;
}

// ---- sleep detection --------------------------------------------------------

let lastSleepCheck = { hrtimeNs: hostNowNs(), epochMs: Date.now() };
/** True when wall time advanced ≥ `thresholdMs` more than steady time since
 *  the previous call — i.e. the machine slept and hrtime paused. Callers
 *  invalidate calibrations on true. */
export function sleepDetected(thresholdMs = 2000): boolean {
  const now = { hrtimeNs: hostNowNs(), epochMs: Date.now() };
  const steadyMs = Number((now.hrtimeNs - lastSleepCheck.hrtimeNs) / 1_000_000n);
  const wallMs = now.epochMs - lastSleepCheck.epochMs;
  lastSleepCheck = now;
  return wallMs - steadyMs >= thresholdMs;
}

// ---- camera measurement (latch-first) --------------------------------

/** GenICam feature spellings (SFNC; FLIR/Basler-compatible). The latched value
 *  is nanoseconds on modern USB3V cameras — verify per camera model. */
const LATCH_EXEC = "TimestampLatch";
const LATCH_VALUE = "TimestampLatchValue";

/** The camera surface these routines need (structural — tests fake it). */
export type LatchableCamera = Pick<Camera, "executeFeature" | "getFeatureInt">;

/** Primary path: N latch round-trips, min-filtered by RTT.
 *  No exposure changes, no streaming — cheap enough for periodic drift
 *  re-runs. Throws when the camera lacks the latch features (caller decides
 *  whether the pull fallback is enabled). */
export function latchCameraOffset(
  camera: LatchableCamera,
  { n = 10, now = hostNowNs }: { n?: number; now?: () => bigint } = {},
): ClockCalibration {
  const samples: OffsetSample[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    camera.executeFeature(LATCH_EXEC);
    const t1 = now();
    const value = camera.getFeatureInt(LATCH_VALUE);
    samples.push({
      midNs: (t0 + t1) / 2n,
      rttNs: t1 - t0,
      subjectNs: BigInt(Math.trunc(value)),
    });
  }
  const { offsetNs, jitterNs } = estimateOffsetNs(samples);
  return { offsetNs, jitterNs, samples: n, method: "latch", atNs: now() };
}

/** Fallback (config-gated, DISABLED by default): pull N frames at 1 ms
 *  exposure; offset = min(arrival − deviceTs). Requires the
 *  caller to own exposure save/restore and frame grabbing — injected so this
 *  stays pure of acquisition details. */
export function pullCameraOffset(
  grabOne: () => { deviceTimestampNs: bigint; arrivalHostNs: bigint },
  { n = 10, now = hostNowNs }: { n?: number; now?: () => bigint } = {},
): ClockCalibration {
  const samples: OffsetSample[] = [];
  for (let i = 0; i < n; i++) {
    const f = grabOne();
    samples.push({ midNs: f.arrivalHostNs, rttNs: 0n, subjectNs: f.deviceTimestampNs });
  }
  const { offsetNs, jitterNs } = estimateOffsetOneSidedNs(samples);
  return { offsetNs, jitterNs, samples: n, method: "pull", atNs: now() };
}

/** Controller ping — N `System.Timestamp` reads (MCU uint64 MICROSECONDS,
 *  stamped at parse time firmware-side), bracketed by host ns. Injected read
 *  fn so this works against the fake device in tests and the real
 *  `Controller.readTimestamp()` alike. */
export async function pingControllerOffset(
  readTimestampUs: () => Promise<bigint>,
  { n = 10, now = hostNowNs }: { n?: number; now?: () => bigint } = {},
): Promise<ClockCalibration> {
  const samples: OffsetSample[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    const us = await readTimestampUs();
    const t1 = now();
    samples.push({ midNs: (t0 + t1) / 2n, rttNs: t1 - t0, subjectNs: us * 1000n });
  }
  const { offsetNs, jitterNs } = estimateOffsetNs(samples);
  return { offsetNs, jitterNs, samples: n, method: "ping", atNs: now() };
}

// ---- fallback gate ----------------------------------------------

let pullFallbackEnabled = false;
export function setPullFallbackEnabled(enabled: boolean): void {
  pullFallbackEnabled = enabled;
}
export function isPullFallbackEnabled(): boolean {
  return pullFallbackEnabled;
}
