// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the manage-cameras session — a live property snapshot per
// camera (`telemetry.views`, keyed by serial); edits + the pixel-format
// reconfigure flow are commands.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { AutoMode, CameraControlsView, Range, Role } from "@lib/camera-config";
import type { CameraInfo } from "@lib/orchestrator/contracts";

export type { CameraInfo };
// Canonical `Range`/`AutoMode` live with the control schema (@lib/camera-config);
// re-exported here so existing `./contract` importers keep working.
export type { Range, AutoMode };

/** Live UI-bound property snapshot for one camera. A flat `type` literal (not
 *  `& CameraControlsView`) so it keeps an implicit index signature assignable to
 *  the wire `Serializable` constraint; the tunable half is schema-guarded below. */
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

// Drift guard (A-P11): the control half of `CameraView` must be structurally
// identical to the schema-owned `CameraControlsView` in @lib/camera-config —
// `readControlFields` is typed to produce that, and `readView` spreads it into
// a `CameraView`. If either side gains/loses/retypes a control field, one of
// these assignments fails to compile.
type ControlHalf = Omit<CameraView, "description" | "role" | "pixel_format" | "pixel_format_options">;
type _AB = CameraControlsView extends ControlHalf ? true : never;
type _BA = ControlHalf extends CameraControlsView ? true : never;
const _controlsConform: [_AB, _BA] = [true, true];
void _controlsConform;

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
