// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Undistorted-stream pipe helper (C-23, real-1g; re-chained per
// docs/proposals/unified-time-and-topology.md §5): sessions advertise a
// first-class `camera/<serial>/undistort` SHM pipe alongside the registry's
// `camera/<serial>/convert` one. SESSION-scoped (not registry-scoped) because
// the producer needs the center calibration, which only the session loads
// (`triple.undistort.calibration`). The native undistort brick CHAINS ON THE
// SHARED CONVERTER (source = the convert brick's pipeId — BGRA in, never raw
// Bayer; demand propagates: the undistort running keeps the converter awake)
// and is gated by the pipe's own connectPipe refcount (C-21) — the remap runs
// only while someone reads.
//
// Two variants (proposal §5 semantics per camera):
//  - CENTER: classic intrinsic undistort (`{ cal }` — cached remap maps built
//    natively from the plain persisted calibration JSON).
//  - L/R (mirror-steered fovea cams): `{ homography: true }` — per-frame
//    `warpPerspective` with H looked up from the brick's native ParamRing by
//    the frame's host-ns time; H samples are pushed by a session-owned
//    `homography-feeder` (Aravis.pushHomography). An empty ring passes frames
//    through untouched (metered as `passthrough` — honest).
//
// Encoding (ruled once): id `camera/<serial>/undistort` exactly parallel to
// `camera/<serial>/convert`; pixel format lives in `spec.pixelFormat` (RGBA8
// first), NOT in the id. A future second format of the same stream is a
// separate pipe id with an `@<format>` suffix.

import type { Camera } from "core/Aravis";
import type { CameraCalibration } from "core/Vision";
import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";
import { nodeId } from "@lib/orchestrator/graph-contract.js";

/** The attach variant selector — mirrors the native `UndistortPipeOptions`
 *  minus the retired legacy positional-cal form (chained bricks only). */
export type UndistortAttachOptions =
  | { cal: CameraCalibration }
  | { homography: true; ringCapacity?: number };

/** The seam this helper drives — `advertise`/`unadvertise` MUST be the pipe
 *  session handle's (discovery-mutating: renderers find the pipe via
 *  `state.pipes`), not bare native `Pipe.advertise`; `attach`/`detach` wrap
 *  `Aravis.attachUndistortPipe`/`detachUndistortPipe`. `attach`'s source is
 *  the CONVERT brick's pipeId (unified-topology §5 — the brick chains on the
 *  shared converter; the legacy Camera-object source is retired here).
 *  Injected (not imported) so sessions and their vitest never load native
 *  core. */
export interface UndistortPipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  attach(sourcePipeId: string, pipeId: string, options: UndistortAttachOptions): void;
  detach(pipeId: string): void;
}

// C-24 step 1: path-like node id (formerly `undistort:<serial>`) — the single
// spelling lives in `nodeId` (graph-contract); this alias keeps call-site naming.
export const undistortPipeId = nodeId.undistort;

/** Shared advertise half: the ruled RGBA8 spec at camera dims (both variants
 *  are 1:1 warps). Advertise BEFORE attach — the producer must find its pipe. */
function advertisePipe(
  seam: UndistortPipeSeam,
  camera: Pick<Camera, "serial" | "getFeatureInt">,
): string {
  const pipeId = undistortPipeId(camera.serial);
  // Width/Height are integer GenICam nodes (same accessor note as
  // `advertiseCameraPipe` in registry.ts).
  const width = camera.getFeatureInt("Width");
  const height = camera.getFeatureInt("Height");
  const channels = 4;
  seam.advertise({
    id: pipeId,
    pixelFormat: "RGBA8",
    dtype: "U8",
    width,
    height,
    channels,
    stride: width * channels,
    bytesPerFrame: width * height * channels,
    ringDepth: 4,
  });
  return pipeId;
}

/** Advertise the `camera/<serial>/undistort` pipe + attach the INTRINSIC
 *  undistort brick chained on the camera's shared converter (center camera).
 *  `cal` is the PLAIN persisted CameraCalibration record (exactly what
 *  `loadIntrinsic` reads); the remap maps are rebuilt natively on attach.
 *  Same dims as the camera (the remap is 1:1). Returns the pipe id. */
export function advertiseUndistortPipe(
  seam: UndistortPipeSeam,
  camera: Pick<Camera, "serial" | "getFeatureInt">,
  cal: CameraCalibration,
): string {
  const pipeId = advertisePipe(seam, camera);
  seam.attach(nodeId.convert(camera.serial), pipeId, { cal });
  return pipeId;
}

/** Advertise the `camera/<serial>/undistort` pipe + attach the HOMOGRAPHY
 *  undistort brick chained on the camera's shared converter (the L/R
 *  mirror-steered cameras — proposal §5). No calibration record: the warp is
 *  driven per frame by H samples the session pushes via a homography feeder
 *  (`startHomographyFeeder`); until samples flow the brick passes frames
 *  through untouched. Returns the pipe id. */
export function advertiseHomographyUndistortPipe(
  seam: UndistortPipeSeam,
  camera: Pick<Camera, "serial" | "getFeatureInt">,
  ringCapacity?: number,
): string {
  const pipeId = advertisePipe(seam, camera);
  seam.attach(nodeId.convert(camera.serial), pipeId, {
    homography: true,
    ...(ringCapacity !== undefined ? { ringCapacity } : {}),
  });
  return pipeId;
}

/** Detach the producer + un-advertise (consumers see CLOSED and disconnect). */
export function retireUndistortPipe(seam: UndistortPipeSeam, pipeId: string): void {
  seam.detach(pipeId);
  seam.unadvertise(pipeId);
}
