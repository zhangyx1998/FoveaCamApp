// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the live camera view (`liveview`) session — the
// streaming-path validation slice. Pick a camera by serial (`state.serial`);
// the orchestrator opens it and the renderer binds its `camera:<serial>` convert
// pipe via `usePipeFrame` (real-1c — no `session.frame`). No calibration or
// controller involved.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { CameraInfo } from "@lib/orchestrator/contracts";

export type { CameraInfo };

export const liveview = defineContract({
  state: { serial: "" },
  telemetry: { cameras: [] as CameraInfo[] },
  // No session frames: the live view binds the camera's native `camera:<serial>`
  // pipe via `usePipeFrame` (real-1c), not `session.frame`.
  frames: [] as const,
  commands: {
    /** Rescan connected cameras; also pushed as telemetry. */
    refresh: cmd<void, CameraInfo[]>(),
  },
});

export type LiveViewContract = typeof liveview;
