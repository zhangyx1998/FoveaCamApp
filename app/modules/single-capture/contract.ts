// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the live camera view (`liveview`) session — pick a camera by
// serial; the renderer binds its `camera:<serial>` pipe via `usePipeFrame`. No
// calibration or controller.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { CameraInfo } from "@lib/orchestrator/contracts";

export type { CameraInfo };

export const liveview = defineContract({
  state: { serial: "" },
  telemetry: { cameras: [] as CameraInfo[] },
  // No session frames: the live view binds `camera:<serial>` via usePipeFrame.
  frames: [] as const,
  commands: {
    /** Rescan connected cameras; also pushed as telemetry. */
    refresh: cmd<void, CameraInfo[]>(),
  },
});

export type LiveViewContract = typeof liveview;
