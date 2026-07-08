// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

export type SnapshotWindow = {
  startedAt: number;
  snapshotAt: number;
  uptimeMs: number;
};

export type CounterRate = {
  count: number;
  ratePerSec: number;
};

/** A workload input/output stream counter with the C-18 diagnostic:
 *  `maxIntervalMs` = the largest gap (ms) between consecutive events over the
 *  trailing window (0 = no data / no gap yet). Mirrors `metering.ts`'s
 *  `WorkloadStreamStat`; kept OPTIONAL here so the profiler reads it typed
 *  (not `as any`) while pre-C-18 snapshots/fixtures that omit it still fit. */
export type WorkloadStreamStat = CounterRate & { maxIntervalMs?: number };

export type SampleStats = {
  count: number;
  mean: number;
  max: number;
};

export type DropSnapshot = {
  total: number;
  ratePerSec: number;
  byReason: Record<string, number>;
};

/** FIFO input-queue stats (controller-node-and-fifo-edges §1/§2): present only
 *  on workloads whose input is a bounded FIFO (e.g. the undistort brick).
 *  `highWater` = max queued depth over the trailing 10s window; `depth` = the
 *  last-sampled depth. Replaces the drop rate on FIFO (lossless) edges. */
export type QueueStat = {
  depth: number;
  highWater: number;
  capacity: number;
};

export type WorkloadSnapshot = {
  name: string;
  window: SnapshotWindow;
  utilization: number;
  busyMs: number;
  inputs: Record<string, WorkloadStreamStat>;
  outputs: Record<string, WorkloadStreamStat>;
  drops: DropSnapshot;
  queue?: QueueStat;
};

export function snapshotWindow(startedAt: number, now = Date.now()): SnapshotWindow {
  return { startedAt, snapshotAt: now, uptimeMs: Math.max(1, now - startedAt) };
}

export function ratePerSec(count: number, window: SnapshotWindow): number {
  return count / (window.uptimeMs / 1000);
}

export function counterRate(count: number, window: SnapshotWindow): CounterRate {
  return { count, ratePerSec: ratePerSec(count, window) };
}

export function formatCounterRate(counter: CounterRate): string {
  return `${counter.count} (${counter.ratePerSec.toFixed(2)}/s)`;
}

export function formatSampleStats(sample: SampleStats, unit = "ms"): string {
  return `${sample.mean.toFixed(2)} ${unit} (max ${sample.max.toFixed(2)}, n=${sample.count})`;
}

/** Humanize a byte throughput for display (JSON keeps raw numbers): 1023 →
 *  "1023 B/s", 1.5e6 → "1.50 MB/s". Binary-1000 steps (network convention). */
export function humanBytesPerSec(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec)) return "—";
  const units = ["B/s", "kB/s", "MB/s", "GB/s"];
  let v = bytesPerSec;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${u === 0 ? Math.round(v) : v.toFixed(2)} ${units[u]}`;
}

/** Humanize an event frequency for display: 0.5 → "0.50 Hz", 1500 →
 *  "1.50 kHz". */
export function humanHz(hz: number): string {
  if (!Number.isFinite(hz)) return "—";
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${hz.toFixed(2)} Hz`;
}
