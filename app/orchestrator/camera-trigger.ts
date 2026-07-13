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
 *  specific. Defaults follow the FLIR line map AND the rig's physical
 *  wiring: ONLY the opto-isolated pins + opto-GND are cabled
 *  (docs/hardware/rig.md §Cameras) — Line0 = opto input (trigger),
 *  Line1 = opto output (strobe); a non-isolated line can never work on
 *  this rig. Verify against `lease.camera.trigger_source_options` on a
 *  new camera model. */
export interface TriggerLines {
  triggerSource?: string;
  lineSelector?: string;
}

/**
 * Switches `lease`'s camera into hardware-triggered mode and configures
 * `lineSelector` as an ExposureActive output (strobe) via the generic
 * feature accessors. `setTrigger` wraps `arv_camera_set_trigger(source)`,
 * whose argument is the trigger SOURCE — Aravis itself sets TriggerMode=On,
 * TriggerSelector=FrameStart, and TriggerActivation=RisingEdge. (Passing
 * "FrameStart" here fails with "[TriggerSource] 'FrameStart' not an entry"
 * — rig-caught 2026-07-12; the deleted sync.ts original had the same
 * never-run bug.) Runs through `lease.reconfigure()` so shared-handle
 * mutation stays on the lease's safe path — pipe consumers ride the
 * transient.
 */
export async function enableHardwareTrigger(
  lease: CameraLease,
  { triggerSource = "Line0", lineSelector = "Line1" }: TriggerLines = {},
): Promise<void> {
  await lease.reconfigure(() => {
    const { camera } = lease;
    camera.setTrigger(triggerSource);
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

/** GenICam nodes whose live values name the trigger-sync freeze cause. */
const TRIGGER_CONFIG_FEATURES = [
  "TriggerMode",
  "TriggerSelector",
  "TriggerSource",
  "TriggerActivation",
  "LineSelector",
  "LineMode",
  "LineSource",
  "ExposureMode",
  "ExposureAuto",
] as const;

/** Best-effort snapshot of a leased camera's trigger/strobe/exposure GenICam
 *  state for diagnostic spans — no reconfigure, reads only. Every node is read
 *  independently; a node the model lacks stores `<error: …>` for that key
 *  instead of failing the whole snapshot. */
export function readTriggerConfig(lease: CameraLease): Record<string, string> {
  const { camera } = lease;
  const out: Record<string, string> = {};
  const probe = (key: string, read: () => string): void => {
    try {
      out[key] = read();
    } catch (e) {
      const line = (e instanceof Error ? e.message : String(e)).split("\n", 1)[0];
      out[key] = `<error: ${line}>`;
    }
  };
  for (const name of TRIGGER_CONFIG_FEATURES)
    probe(name, () => camera.getFeature(name));
  probe("trigger_source", () => camera.trigger_source);
  probe("trigger_source_options", () => camera.trigger_source_options.join(", "));
  return out;
}
