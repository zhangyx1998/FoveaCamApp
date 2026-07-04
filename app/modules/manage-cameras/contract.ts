// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the manage-cameras session. The orchestrator owns every
// camera; it publishes a live property snapshot per camera (`telemetry.views`,
// keyed by serial) and a preview frame channel per serial (dynamic name).
// Edits and the pixel-format reconfigure flow are commands.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { Role } from "@lib/camera-config";
import type { CameraInfo } from "@lib/orchestrator/contracts";

export type { CameraInfo };
export type Range = { min: number; max: number };
export type AutoMode = "Off" | "Once" | "Continuous";

/** Live, UI-bound property snapshot for one camera (polled by the orchestrator). */
export type CameraView = {
  description: string;
  role?: Role;
  pixel_format: string;
  pixel_format_options: string[];
  frame_rate_available: boolean;
  frame_rate_enable: boolean;
  frame_rate: number;
  frame_rate_range: Range;
  exposure_auto_available: boolean;
  exposure_auto: AutoMode;
  exposure: number;
  exposure_range: Range;
  gain_auto_available: boolean;
  gain_auto: AutoMode;
  gain: number;
  gain_range: Range;
  black_level_available: boolean;
  black_level_auto_available: boolean;
  black_level_auto: AutoMode;
  black_level: number;
  black_level_range: Range;
};

export const manageCameras = defineContract({
  state: {},
  telemetry: {
    list: [] as CameraInfo[],
    /** Per-camera live snapshot, keyed by serial. */
    views: {} as Record<string, CameraView>,
  },
  // Preview channels are dynamic, one per serial (e.g. `frame(serial)`).
  frames: [] as const,
  commands: {
    /** Rescan connected cameras; also pushed as telemetry. */
    refresh: cmd<void, CameraInfo[]>(),
    /** Set a camera property (or `role`) and persist it. */
    set: cmd<{ serial: string; key: string; value: unknown }>(),
    /** Change pixel format (pauses/reconfigures acquisition) and persist it. */
    setPixelFormat: cmd<{ serial: string; format: string }>(),
    /** Reset a camera to auto defaults and clear its stored config. */
    reset: cmd<{ serial: string }>(),
  },
});

export type ManageCamerasContract = typeof manageCameras;
