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

export function snapshotWindow(startedAt: number, now = Date.now()): SnapshotWindow {
  return { startedAt, snapshotAt: now, uptimeMs: Math.max(1, now - startedAt) };
}

export function ratePerSec(count: number, window: SnapshotWindow): number {
  return count / (window.uptimeMs / 1000);
}

export function counterRate(count: number, window: SnapshotWindow): CounterRate {
  return { count, ratePerSec: ratePerSec(count, window) };
}
