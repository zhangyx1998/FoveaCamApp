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

export type WorkloadSnapshot = {
  name: string;
  window: SnapshotWindow;
  utilization: number;
  busyMs: number;
  inputs: Record<string, CounterRate>;
  outputs: Record<string, CounterRate>;
  drops: DropSnapshot;
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
