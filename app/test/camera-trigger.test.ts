// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Camera hardware-trigger config (spec disparity-scope §trigger-sync): both
// directions ride `lease.reconfigure()`, enable programs the trigger source
// + the strobe line, disable clears — driven with a fake lease (no native core).

import { describe, expect, it, vi } from "vitest";
import {
  disableHardwareTrigger,
  enableHardwareTrigger,
} from "@orchestrator/camera-trigger";
import type { CameraLease } from "@orchestrator/registry";

function makeFakeLease() {
  const features: Record<string, string> = {};
  const camera = {
    setTrigger: vi.fn(),
    clearTriggers: vi.fn(),
    setFeature: vi.fn((name: string, value: string) => {
      features[name] = value;
    }),
  };
  const lease = {
    camera,
    reconfigure: vi.fn(async (mutate: () => void | Promise<void>) => {
      await mutate();
    }),
    release: vi.fn(),
  };
  return { lease: lease as unknown as CameraLease, raw: lease, camera, features };
}

describe("enableHardwareTrigger", () => {
  it("programs the trigger SOURCE + ExposureActive strobe through reconfigure", async () => {
    const { lease, raw, camera, features } = makeFakeLease();
    await enableHardwareTrigger(lease);
    expect(raw.reconfigure).toHaveBeenCalledTimes(1);
    // setTrigger takes the SOURCE (arv_camera_set_trigger semantics — Aravis
    // sets TriggerMode/TriggerSelector itself). Passing "FrameStart" was the
    // rig-caught 2026-07-12 failure; pin the argument.
    expect(camera.setTrigger).toHaveBeenCalledWith("Line0");
    expect(features).toEqual({
      LineSelector: "Line1",
      LineMode: "Output",
      LineSource: "ExposureActive",
    });
    expect(camera.clearTriggers).not.toHaveBeenCalled();
  });

  it("honors explicit trigger/strobe line names", async () => {
    const { lease, camera, features } = makeFakeLease();
    await enableHardwareTrigger(lease, {
      triggerSource: "Line2",
      lineSelector: "Line3",
    });
    expect(camera.setTrigger).toHaveBeenCalledWith("Line2");
    expect(features.LineSelector).toBe("Line3");
  });

  it("propagates a feature-write failure (caller reverts + surfaces it)", async () => {
    const { lease, camera } = makeFakeLease();
    camera.setTrigger.mockImplementation(() => {
      throw new Error("TriggerMode not writable");
    });
    await expect(enableHardwareTrigger(lease)).rejects.toThrow(
      "TriggerMode not writable",
    );
  });
});

describe("disableHardwareTrigger", () => {
  it("clears triggers through reconfigure (back to free-run)", async () => {
    const { lease, raw, camera } = makeFakeLease();
    await disableHardwareTrigger(lease);
    expect(raw.reconfigure).toHaveBeenCalledTimes(1);
    expect(camera.clearTriggers).toHaveBeenCalledTimes(1);
    expect(camera.setTrigger).not.toHaveBeenCalled();
  });
});
