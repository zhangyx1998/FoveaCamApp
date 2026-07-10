// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure camera helpers shared by the renderer (`@lib/camera`) and the
// orchestrator (camera-owning sessions). Dependency-free (only a `Camera`
// *type* import) so it loads in any process — no Vue, Store, or DOM.

import type { Camera } from "core/Aravis";
import type { Point2d, Point3d } from "core/Geometry";

export const ROLE = {
  L: "Left Fovea",
  C: "Center Wide",
  R: "Right Fovea",
};

// L/C/R role colors. This is the source of truth for JS consumers; it stays a
// plain constant (no CSS-var read) because it also loads in the DOM-less
// orchestrator process. The CSS tokens `--role-l/-c/-r` in `src/tokens.css`
// MIRROR these values — keep the two in lockstep.
export const THEME = {
  L: "cyan",
  C: "orange",
  R: "greenyellow",
};

export type Triple<TL = any, TC = TL, TR = TL> = {
  L: TL;
  C: TC;
  R: TR;
};

export type Role = keyof Triple;

export type Range = { min: number; max: number };
export type AutoMode = "Off" | "Once" | "Continuous";

// ---- Tunable camera controls (A-P11) --------------------------------------
// One declarative schema for the frame-rate / exposure / gain / black-level
// family, which otherwise repeats across the manage-cameras wire type
// (`CameraView`), the 1 Hz read snapshot, the reset defaults, and the UI.
// Every consumer derives its per-control fields from here so the family can't
// drift (a bug class: a new sub-field wired into three of four places).
//
// Field-key names ARE the native `Camera` getter/setter keys AND the
// `CameraView` field names — one identifier, no mapping table. Fields absent
// on a control (frame rate has an enable toggle, not an auto mode; only black
// level has both an availability probe and an auto probe) are simply omitted.

export interface CameraControl {
  /** Value getter/setter key (also the `CameraView` value field). */
  key: string;
  label: string;
  units: string;
  /** Field gating whether the control is exposed (its fieldset `v-if`). */
  availableKey: string;
  /** `{min,max}` range field. */
  rangeKey: string;
  /** Auto-mode field (exposure/gain/black level); omitted for frame rate. */
  autoKey?: string;
  /** Extra gate for the auto mode (black level only). */
  autoAvailableKey?: string;
  /** Manual-enable toggle (frame rate only — it has no auto mode). */
  enableKey?: string;
  /** Formats the raw value for the readout — schema-owned so every consumer
   *  renders it identically. */
  format: (v: number) => string;
}

export const CAMERA_CONTROLS: readonly CameraControl[] = [
  {
    key: "frame_rate",
    label: "Frame Rate",
    units: "FPS",
    availableKey: "frame_rate_available",
    rangeKey: "frame_rate_range",
    enableKey: "frame_rate_enable",
    format: (v) => `${v.toFixed(2)} FPS`,
  },
  {
    key: "exposure",
    label: "Exposure",
    units: "ms",
    availableKey: "exposure_auto_available",
    rangeKey: "exposure_range",
    autoKey: "exposure_auto",
    format: (v) => `${(v / 1000).toFixed(2)} ms`,
  },
  {
    key: "gain",
    label: "Gain",
    units: "dB",
    availableKey: "gain_auto_available",
    rangeKey: "gain_range",
    autoKey: "gain_auto",
    format: (v) => `${v.toFixed(2)} dB`,
  },
  {
    key: "black_level",
    label: "Black Level",
    units: "dB",
    availableKey: "black_level_available",
    rangeKey: "black_level_range",
    autoKey: "black_level_auto",
    autoAvailableKey: "black_level_auto_available",
    format: (v) => `${v.toFixed(2)} dB`,
  },
];

/** The control-family half of `CameraView` — kept here (the pure, both-process
 *  home) so `readControlFields` produces exactly it; the manage-cameras contract
 *  keeps its own flat `CameraView` (a `type` literal, for `Serializable`) with a
 *  compile-time drift guard against this. A `type` (not `interface`) so it gets
 *  an implicit index signature where callers need one. */
export type CameraControlsView = {
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
}

const ZERO_RANGE: Range = { min: 0, max: 0 };

/**
 * Read every control's snapshot fields off a live camera through the caller's
 * throw-guard (`safe`), preserving the exact per-field fallbacks the 1 Hz poll
 * relies on: a camera can be force-released mid-poll (§12.1 C2), and an
 * unguarded read on a released `CoreObject` throws — uncaught in `setInterval`
 * it would crash the orchestrator. The reader is injected so this stays pure
 * (no `core` import) and unit-testable with a fake camera.
 */
export function readControlFields(
  camera: Record<string, any>,
  safe: <T>(get: () => T, fallback: T) => T,
): CameraControlsView {
  const out: Record<string, unknown> = {};
  for (const ctrl of CAMERA_CONTROLS) {
    out[ctrl.key] = safe(() => camera[ctrl.key] as number, 0);
    out[ctrl.rangeKey] = safe(() => camera[ctrl.rangeKey] as Range, ZERO_RANGE);
    out[ctrl.availableKey] = safe(() => camera[ctrl.availableKey] as boolean, false);
    if (ctrl.autoKey) out[ctrl.autoKey] = safe(() => camera[ctrl.autoKey!] as AutoMode, "Off");
    if (ctrl.autoAvailableKey)
      out[ctrl.autoAvailableKey] = safe(() => camera[ctrl.autoAvailableKey!] as boolean, false);
    if (ctrl.enableKey) out[ctrl.enableKey] = safe(() => camera[ctrl.enableKey!] as boolean, false);
  }
  return out as unknown as CameraControlsView;
}

export function describeCamera(camera: Camera | Empty) {
  if (!camera) return "Camera Not Connected";
  return `${camera.vendor} ${camera.model} (${camera.serial})`;
}

export type CameraDescription = ReturnType<typeof describeCamera>;

function normalizePathSegment(segment: string) {
  return segment.trim().replace(/\s+/g, "-");
}

/** Only needs the identity fields — accepts a live `Camera` or a plain
 *  `{vendor, model, serial}` descriptor (e.g. `CameraInfo`), so callers can
 *  derive a config path without opening the camera. */
export function getCameraKey(camera: Pick<Camera, "vendor" | "model" | "serial">) {
  return [camera.vendor, camera.model, camera.serial]
    .map(normalizePathSegment)
    .join("_");
}

export function getCameraInfo(camera?: Camera) {
  const { frame_rate = NaN, exposure = NaN, gain = NaN } = camera ?? {};
  return {
    Vendor: camera?.vendor ?? "Unknown",
    Camera: camera?.model ?? "Unknown",
    Serial: camera?.serial ?? "Unknown",
    FrameRate: `${frame_rate?.toFixed(2) ?? 0} FPS`,
    Exposure: `${(exposure / 1000)?.toFixed(2) ?? 0} ms`,
    Gain: `${gain?.toFixed(2) ?? 0} dB`,
  };
}

// Per-fovea extrinsic calibration sample (moved here from the now-retired
// `lib/camera.ts` — docs/history/refactor/orchestrator.md §7.1 S1c — since both
// `orchestrator/calibration.ts` and `modules/calibrate-extrinsic/session.ts`
// need the type and this file is the dependency-free, both-processes home
// for pure camera types).
export type ExtrinsicData = {
  /** Outer + internal marker corners. */
  img_points: Point2d[];
  /** 3D positions of corresponding `img_points`. */
  obj_points: Point3d[];
  /** Absolute voltage reading (x, y) in volts. */
  voltage: Point2d;
  /** Angular position (x, y) from the wide camera, in radians. */
  angle: Point2d;
  /** MEASURED-magnification inputs (ruled 2026-07-09). All optional — absent
   *  on legacy datasets, which then carry NO measured magnification. See
   *  `recordMagnification`/`fitMagnification` (@lib/coordinate-conversions). */
  /** Ruling 3 (preferred): the WIDE (C) camera's outer quad of the SAME side
   *  marker this eye's fovea tracks (`C.side_pts[key]` at capture). */
  wide_img_points?: Point2d[];
  /** Ruling 2 (fallback): the wide camera's own CENTER-marker outer quad
   *  (`C.img_pts.slice(0, 4)` at capture). */
  wide_center_points?: Point2d[];
  /** Ruling 2: marker sizes (mm) at capture — center is sized independently. */
  marker?: { side_mm: number; center_mm: number };
};

export type ExtrinsicDataset = ExtrinsicData[];

export function initCamera(camera: Camera, config: Partial<Camera>) {
  // Pixel format must be applied before acquisition starts (it changes the
  // stream payload size), so restore it first.
  if (config.pixel_format !== undefined) {
    try {
      camera.pixel_format = config.pixel_format;
    } catch (e) {
      console.warn("Failed to restore pixel format:", config.pixel_format, e);
    }
  }
  if (config.frame_rate_enable !== undefined)
    camera.frame_rate_enable = config.frame_rate_enable;
  if (!camera.frame_rate_enable && config.frame_rate !== undefined)
    camera.frame_rate = config.frame_rate;
  if (config.exposure_auto !== undefined)
    camera.exposure_auto = config.exposure_auto;
  if (camera.exposure_auto === "Off" && config.exposure !== undefined)
    camera.exposure = config.exposure;
  if (config.gain_auto !== undefined) camera.gain_auto = config.gain_auto;
  if (camera.gain_auto === "Off" && config.gain !== undefined)
    camera.gain = config.gain;
  return camera;
}
