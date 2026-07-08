// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Synced-capture host service (docs/history/refactor/synced-capture.md §6). Owns:
//  - camera trigger-mode config (L/R hardware-triggered, C stays free-run)
//  - clock calibration (per-camera device-clock <-> MCU Global::time delta)
//  - L/R pair matching by (calibrated) device timestamp
//
// Calibration/matching below are written against a small `DeviceTimestamped`
// shape. Native `core/Aravis` Frames now satisfy that shape via
// `frame.deviceTimestamp`; tests can still use synthetic timestamp objects.

import type { CameraLease } from "./registry.js";
import type { Controller, FrameOutcome } from "./controller.js";

/** Anything with a device-clock capture timestamp. Native `core/Aravis`
 *  Frames satisfy this via `Frame.deviceTimestamp`. Units are whatever the
 *  device clock counts in (the real Aravis buffer timestamp is nanoseconds) —
 *  `calibrate`/`matchPair` don't care, as long as one camera's frames and
 *  its own calibration delta are in the same units consistently. */
export interface DeviceTimestamped {
  readonly deviceTimestamp: bigint;
}

/** Per-camera (L/R) offset from its own device clock into the MCU's
 *  `Global::time` domain: `mcuTime ≈ deviceTimestamp + delta`. */
export interface ClockCalibration {
  readonly left: bigint;
  readonly right: bigint;
}

/**
 * One-shot clock calibration (docs/history/refactor/synced-capture.md §6): triggers
 * a single CMD_FRAME on `calibrationStream` and pairs its `tExposure` (MCU
 * time) against the L/R frames' own device timestamps (supplied by the
 * caller — see `DeviceTimestamped`) to compute each camera's delta.
 *
 * Must be re-run after every `Controller.enable()` — the MCU clock resets
 * then (firmware/src/Protocol.cpp `System::Enable` SET), invalidating any
 * previous calibration. `captureLeft`/`captureRight` should resolve with the
 * frame captured *for this trigger* (typically: race the trigger against
 * each camera's next-frame promise, or take the temporally-nearest arrival —
 * how to actually correlate a device-clock-only frame to a specific trigger
 * before calibration exists is itself a chicken-and-egg the real live
 * integration must solve; this signature just decouples that concern from
 * the arithmetic below).
 */
export async function calibrate(
  ctl: Controller,
  calibrationStream: number,
  captureLeft: () => Promise<DeviceTimestamped>,
  captureRight: () => Promise<DeviceTimestamped>,
): Promise<ClockCalibration> {
  const [frame, left, right] = await Promise.all([
    ctl.frame({ stream: calibrationStream, cameras: ["L", "R"] }),
    captureLeft(),
    captureRight(),
  ]);
  return {
    left: frame.tExposure - left.deviceTimestamp,
    right: frame.tExposure - right.deviceTimestamp,
  };
}

/** True if `frame`'s calibrated device timestamp falls within
 *  `toleranceTicks` of `tExposure` (both in MCU-time units) — the doc's
 *  matching rule (§6): "± half the minimum frame interval". */
export function matchesExposure(
  frame: DeviceTimestamped,
  calibrationDelta: bigint,
  tExposure: bigint,
  toleranceTicks: bigint,
): boolean {
  const predicted = frame.deviceTimestamp + calibrationDelta;
  const diff =
    predicted > tExposure ? predicted - tExposure : tExposure - predicted;
  return diff <= toleranceTicks;
}

/**
 * Pairs the L and R frames (from each camera's own free-running arrival
 * queue/buffer) whose calibrated device timestamps fall within
 * `toleranceTicks` of `frame.tExposure` (docs/history/refactor/synced-capture.md §6
 * "Matching"). Returns null if either side has no candidate within
 * tolerance — the caller decides whether to keep waiting or drop the
 * trigger (e.g. once its own queue window has passed).
 */
export function matchPair<T extends DeviceTimestamped>(
  leftFrames: readonly T[],
  rightFrames: readonly T[],
  calibration: ClockCalibration,
  frame: Pick<FrameOutcome, "tExposure">,
  toleranceTicks: bigint,
): { left: T; right: T } | null {
  const left = leftFrames.find((f) =>
    matchesExposure(f, calibration.left, frame.tExposure, toleranceTicks),
  );
  const right = rightFrames.find((f) =>
    matchesExposure(f, calibration.right, frame.tExposure, toleranceTicks),
  );
  if (!left || !right) return null;
  return { left, right };
}

/** GenICam names for a lease's trigger input + strobe output — camera-model
 *  specific. The defaults below are UNVERIFIED placeholders (bench work is
 *  hardware-gated, docs/history/refactor/synced-capture.md §4/§9); confirm against
 *  `lease.camera.trigger_source_options` before relying on them, and prefer
 *  passing explicit values once the real FLIR L/R wiring is known. */
export interface TriggerLines {
  triggerSource?: string;
  lineSelector?: string;
}

/**
 * Switches `lease`'s camera into hardware-triggered mode (TriggerMode=On via
 * `setTrigger`, TriggerSource=`triggerSource`) and configures
 * `lineSelector` as an ExposureActive output (strobe) via the generic
 * feature accessors (`core/lib/Aravis/Camera.h`'s `get/set/executeFeature`,
 * added for this). Runs through `lease.reconfigure()` so the shared preview
 * loop restarts cleanly (docs/history/refactor/synced-capture.md §6) — every
 * subscriber (live view included) briefly pauses, matching the existing
 * pixel-format-change reconfigure pattern.
 */
export async function enableHardwareTrigger(
  lease: CameraLease,
  { triggerSource = "Line0", lineSelector = "Line1" }: TriggerLines = {},
): Promise<void> {
  await lease.reconfigure(() => {
    const { camera } = lease;
    camera.setTrigger("FrameStart");
    camera.trigger_source = triggerSource;
    camera.setFeature("LineSelector", lineSelector);
    camera.setFeature("LineMode", "Output");
    camera.setFeature("LineSource", "ExposureActive");
  });
}

/** Reverts `enableHardwareTrigger` — back to free-run, matching every other
 *  (non-synced) camera. */
export async function disableHardwareTrigger(
  lease: CameraLease,
): Promise<void> {
  await lease.reconfigure(() => {
    lease.camera.clearTriggers();
  });
}
