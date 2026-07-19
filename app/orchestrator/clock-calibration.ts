// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// JS side of the clock-metrics channel: the hardware owner THREADS own all calibration
// natively (initial + 30s drift). INVARIANT: no JS calibration driver (a second latch
// driver would race the owner on the TimestampLatch register) and no per-brick offset
// push (owner-applied dt makes every timestamp trusted at the source). This module only
// BRIDGES the owner's pushed metrics into time-align.ts via the Aravis.onClockMetrics
// CallbackSlot (a lock-free armed flag skips the uv dispatch until registration).
// spec: docs/spec/controller.md#clock-calibration

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
