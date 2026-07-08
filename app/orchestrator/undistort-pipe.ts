// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Undistorted-stream pipe helper (C-23, real-1g): sessions advertise a
// first-class `undistort:<serial>` SHM pipe alongside the registry's raw
// `camera:<serial>` one. SESSION-scoped (not registry-scoped) because the
// producer needs the center calibration, which only the session loads
// (`triple.undistort.calibration`). B's native producer (camera → convert →
// precomputed-map remap → FrameSink, B-23) attaches on advertise and is gated
// by the pipe's own connectPipe refcount (C-21) — remap runs only while
// someone reads.
//
// Encoding (ruled once): id `undistort:<serial>` exactly parallel to
// `camera:<serial>`; pixel format lives in `spec.pixelFormat` (BGRA8 first),
// NOT in the id. A future second format of the same stream is a separate pipe
// id with an `@<format>` suffix.

import type { Camera } from "core/Aravis";
import type { CameraCalibration } from "core/Vision";
import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";

/** The seam this helper drives — `advertise`/`unadvertise` MUST be the pipe
 *  session handle's (discovery-mutating: renderers find the pipe via
 *  `state.pipes`), not bare native `Pipe.advertise`; `attach`/`detach` wrap
 *  B's `Aravis.attachUndistortPipe`/`detachUndistortPipe`. Injected (not
 *  imported) so sessions and their vitest never load native core. */
export interface UndistortPipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  /** B-23: `cal` is the PLAIN persisted CameraCalibration record (exactly what
   *  `loadIntrinsic` reads — the `Undistort` ctor input); B rebuilds the remap
   *  maps natively on attach. */
  attach(camera: Camera, pipeId: string, cal: CameraCalibration): void;
  detach(pipeId: string): void;
}

export const undistortPipeId = (serial: string): string => `undistort:${serial}`;

/** Advertise the `undistort:<serial>` pipe + attach B's native remap producer.
 *  Same dims as the camera (the remap is 1:1). Returns the pipe id. */
export function advertiseUndistortPipe(
  seam: UndistortPipeSeam,
  camera: Pick<Camera, "serial" | "getFeatureInt">,
  cal: CameraCalibration,
): string {
  const pipeId = undistortPipeId(camera.serial);
  // Width/Height are integer GenICam nodes (same accessor note as
  // `advertiseCameraPipe` in registry.ts).
  const width = camera.getFeatureInt("Width");
  const height = camera.getFeatureInt("Height");
  const channels = 4;
  seam.advertise({
    id: pipeId,
    pixelFormat: "BGRA8",
    dtype: "U8",
    width,
    height,
    channels,
    stride: width * channels,
    bytesPerFrame: width * height * channels,
    ringDepth: 4,
  });
  seam.attach(camera as Camera, pipeId, cal);
  return pipeId;
}

/** Detach B's producer + un-advertise (consumers see CLOSED and disconnect). */
export function retireUndistortPipe(seam: UndistortPipeSeam, pipeId: string): void {
  seam.detach(pipeId);
  seam.unadvertise(pipeId);
}
