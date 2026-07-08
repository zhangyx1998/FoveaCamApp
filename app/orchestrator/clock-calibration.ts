// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// JS side of the clock-metrics channel (unified-time FINAL ruling 0). The
// hardware owner THREADS own calibration — initial at device init +
// incremental drift every 30 s, entirely native (ClockCalibration.cpp).
// There is NO JS calibration driver anymore (a second latch driver would
// race the owner thread on the TimestampLatch device register), and no
// per-brick offset push (owner-applied dt makes every surfaced timestamp
// trusted at the source).
//
// This module just BRIDGES the owner's pushed metrics into the JS-side
// registry (`time-align.ts`) that feeds perfSnapshot.clocks / telemetry:
// `Aravis.onClockMetrics` is the CallbackSlot channel — a lock-free armed
// flag native-side means the owner threads skip the uv dispatch entirely
// until this registration happens.

import type { ClockMetricsRow } from "core/Aravis";
import { setCalibration } from "./time-align.js";

/** Register the clock-metrics callback (main thread — call once at
 *  orchestrator boot). Every successful calibration (initial, drift,
 *  manual) lands here and refreshes the JS registry row the profiler's
 *  clocks section reads. */
export function wireClockMetrics(
  onClockMetrics: (cb: ((row: ClockMetricsRow) => void) | null) => void,
): void {
  onClockMetrics((row) => {
    setCalibration(`camera:${row.serial}`, {
      offsetNs: row.offsetNs,
      jitterNs: row.jitterNs,
      samples: row.samples,
      method: "latch",
      atNs: row.atNs,
      ...(row.driftPpm !== null && row.driftPpm !== undefined
        ? { driftPpm: row.driftPpm }
        : {}),
    });
  });
}
