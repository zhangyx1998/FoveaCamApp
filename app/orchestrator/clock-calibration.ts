// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Boot-sequence clock calibration (unified-time proposal §3): hidden inside
// camera acquisition — `registerShared` fires this per camera; the controller
// session fires the ping variant on connect. Consumers only ever see
// `toHostNs(clock, ts)`.
//
// RULED order: GenICam TimestampLatch first (no exposure changes, no
// streaming, cheap enough for periodic drift re-runs); the 1 ms-exposure
// frame-pull fallback is CONFIG-GATED and DISABLED by default (ruling 2).
// The pull grabs frames via `camera.grab()` — a private acquisition cycle —
// so it must only run while the camera is NOT streaming (true at
// registerShared time: converters are still gate-parked).

import type { Camera } from "core/Aravis";
import { report } from "./diagnostics.js";
import {
  estimateOffsetOneSidedNs,
  hostNowNs,
  isPullFallbackEnabled,
  latchCameraOffset,
  setCalibration,
  type ClockId,
} from "./time-align.js";

const PULL_FRAMES = 10;
const PULL_EXPOSURE_US = 1000; // 1 ms (directive) — minimizes exposure-start ambiguity
const PULL_GRAB_TIMEOUT_MS = 2000;

/** Latch-first camera clock calibration; optionally falls back to the
 *  directive's 1 ms-exposure frame pull (config-gated). Fire-and-forget from
 *  acquisition — never blocks activation, never throws. */
export async function calibrateCameraClock(camera: Camera): Promise<void> {
  const clock: ClockId = `camera:${camera.serial}`;
  try {
    setCalibration(clock, latchCameraOffset(camera));
    return;
  } catch (e) {
    // Latch features unsupported on this model (or transient failure).
    if (!isPullFallbackEnabled()) {
      report(
        "time-align",
        `${clock}: TimestampLatch unavailable (${(e as Error).message}); ` +
          `pull fallback disabled — clock UNCALIBRATED`,
      );
      return;
    }
  }
  try {
    await pullCalibrate(camera, clock);
  } catch (e) {
    report("time-align", `${clock}: pull calibration failed: ${(e as Error).message}`);
  }
}

/** The directive's method: N frames at 1 ms exposure, one camera at a time,
 *  offset = min(arrival − deviceTs) (one-sided min-filter per ruling 1).
 *  Exposure saved/restored around the pulls. */
async function pullCalibrate(camera: Camera, clock: ClockId): Promise<void> {
  const prev = { auto: camera.exposure_auto, exposure: camera.exposure };
  camera.exposure_auto = "Off";
  camera.exposure = PULL_EXPOSURE_US;
  try {
    const samples = [];
    for (let i = 0; i < PULL_FRAMES; i++) {
      const frame = await camera.grab(PULL_GRAB_TIMEOUT_MS);
      const deviceNs = frame.deviceTimestamp;
      const arrivalNs = hostNowNs();
      frame.release(); // extract-then-release (frame-release contract)
      samples.push({ midNs: arrivalNs, rttNs: 0n, subjectNs: deviceNs });
    }
    const { offsetNs, jitterNs } = estimateOffsetOneSidedNs(samples);
    setCalibration(clock, {
      offsetNs,
      jitterNs,
      samples: samples.length,
      method: "pull",
      atNs: hostNowNs(),
    });
  } finally {
    camera.exposure_auto = prev.auto;
    if (prev.auto === "Off") camera.exposure = prev.exposure;
  }
}
