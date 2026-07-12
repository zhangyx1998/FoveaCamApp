// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Camera hardware-trigger mode config (docs/spec/disparity-scope.md
// §trigger-sync): flips a leased camera between free-run and
// FrameStart-triggered capture. Pure over the `CameraLease` seam, so it
// unit-tests with a fake lease (camera-trigger.test.ts).

import type { CameraLease } from "./registry.js";

/** GenICam names for a lease's trigger input + strobe output — camera-model
 *  specific. The defaults below are UNVERIFIED placeholders (bench work is
 *  RIG-GATED, docs/hardware/stage-f.md); confirm against
 *  `lease.camera.trigger_source_options` before relying on them, and prefer
 *  passing explicit values once the real L/R wiring is known. */
export interface TriggerLines {
  triggerSource?: string;
  lineSelector?: string;
}

/**
 * Switches `lease`'s camera into hardware-triggered mode (TriggerMode=On via
 * `setTrigger`, TriggerSource=`triggerSource`) and configures `lineSelector`
 * as an ExposureActive output (strobe) via the generic feature accessors.
 * Runs through `lease.reconfigure()` so shared-handle mutation stays on the
 * lease's safe path — pipe consumers ride the transient.
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

/** Reverts {@link enableHardwareTrigger} — back to free-run, matching every
 *  other (non-synced) camera. */
export async function disableHardwareTrigger(
  lease: CameraLease,
): Promise<void> {
  await lease.reconfigure(() => {
    lease.camera.clearTriggers();
  });
}
