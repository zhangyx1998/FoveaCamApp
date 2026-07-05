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
// `lib/camera.ts` — docs/refactor/orchestrator.md §7.1 S1c — since both
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
