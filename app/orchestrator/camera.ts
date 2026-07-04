// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator-side camera helpers shared by the camera-owning sessions
// (live-view, manage-cameras, calibration): config persistence, enumeration,
// and the BGRA preview-stream loop.

import type { Camera } from "core/Aravis";
import type { Mat } from "core/Vision";
import { getCameraKey, initCamera } from "@lib/camera-config";
import type { CameraInfo } from "@lib/orchestrator/contracts";
import type { FrameMeta, FramePayload } from "@lib/orchestrator/protocol";
import { read } from "./store.js";

/** Store path for a camera's persisted config. Accepts a live `Camera` or
 *  just its identity fields (e.g. a `CameraInfo` from `listCameraInfo()`) —
 *  callers that only need to read a stored value (like a role, to decide
 *  whether to open the camera at all) don't need to open it first. */
export const cameraConfigPath = (
  camera: Pick<Camera, "vendor" | "model" | "serial">,
) => ["cameras", getCameraKey(camera)];

/** Plain, serializable camera descriptor. */
export const cameraInfo = (c: Camera): CameraInfo => ({
  serial: c.serial,
  model: c.model,
  vendor: c.vendor,
});

/** Enumerate connected cameras as plain info, releasing the native handles. */
export async function listCameraInfo(): Promise<CameraInfo[]> {
  const { Camera } = await import("core/Aravis");
  const cameras = await Camera.list();
  try {
    return cameras.map(cameraInfo);
  } finally {
    for (const c of cameras) c.release();
  }
}

/**
 * Restore a camera's persisted config (pixel format, frame rate, exposure,
 * gain). Must run before acquisition starts — pixel format changes the payload
 * size and is locked once streaming.
 */
export async function applyStoredConfig(camera: Camera): Promise<void> {
  initCamera(camera, await read<Partial<Camera>>(cameraConfigPath(camera), {}));
}

/**
 * Convert a BGRA view Mat into a transferable frame payload (copy). Used by the
 * registry's shared preview loop ([`./registry.ts`]) to fan one converted frame
 * out to every viewer. `meta` carries producer-side profiling timestamps
 * (`tCapture`/`convertMs`) where the caller measured them — the transport
 * stamps `seq`/`tPublish` itself on send.
 */
export function toFramePayload(
  view: Mat<Uint8Array>,
  meta?: FrameMeta,
): FramePayload {
  return {
    data: view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer,
    shape: view.shape,
    channels: view.channels,
    meta,
  };
}
