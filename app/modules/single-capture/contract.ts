// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the live camera view (`liveview`) session — the
// streaming-path validation slice. Pick a camera by serial (`state.serial`);
// the orchestrator opens it and publishes BGRA8 frames on the `frame` channel.
// No calibration or controller involved.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { CameraInfo } from "@lib/orchestrator/contracts";

export type { CameraInfo };

export const liveview = defineContract({
  state: { serial: "" },
  telemetry: { cameras: [] as CameraInfo[] },
  frames: ["frame"] as const,
  commands: {
    /** Rescan connected cameras; also pushed as telemetry. */
    refresh: cmd<void, CameraInfo[]>(),
  },
});

export type LiveViewContract = typeof liveview;
