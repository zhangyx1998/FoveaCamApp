// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// General-purpose session-owned SLICE node: a named reuse of the native fovea crop
// brick — a live-steered ROI copy of a source pipe published as its own
// variable-size pipe (each frame carries active dims + frame-bound crop origin).
// The session-owned sibling of createFoveaMaterializer, with named ids outside the
// renderer-composed slot space. Seam-injected (never imports core).
// spec: docs/spec/pipes.md#slice-pipe

import type { Rect } from "core/Geometry";
import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";

/** The seam this helper drives — `advertise`/`unadvertise` MUST be the pipe
 *  session handle's (discovery-mutating); `attach`/`steer`/`detach` wrap the
 *  native fovea crop brick (`attachFoveaPipe`/`setFoveaRect`/
 *  `detachFoveaPipe`) with a PIPE-ID source (chained form only). */
export interface SlicePipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  attach(sourcePipeId: string, pipeId: string, options: { rect: Rect }): void;
  steer(pipeId: string, rect: Rect): void;
  detach(pipeId: string): void;
}

export interface SlicePipeOptions {
  /** Initial crop rect, in SOURCE-frame pixels. */
  rect: Rect;
  /** Ring footprint (max dims — a later `steer` may grow the crop up to
   *  this; the native brick clamps beyond it). */
  maxWidth: number;
  maxHeight: number;
}

export interface SliceHandle {
  readonly pipeId: string;
  /** Live-steer the crop (applied on the next frame; clamped to the frame
   *  domain + the ring's max footprint). */
  steer(rect: Rect): void;
  /** Detach the producer + un-advertise (consumers see CLOSED). */
  retire(): void;
}

/** Advertise the max-footprint pipe + attach the crop brick chained on
 *  `sourcePipeId` (an undistort/convert pipe). Advertise BEFORE attach — the
 *  producer must find its pipe. */
export function createSlicePipe(
  seam: SlicePipeSeam,
  sourcePipeId: string,
  pipeId: string,
  opts: SlicePipeOptions,
): SliceHandle {
  const { rect, maxWidth, maxHeight } = opts;
  const channels = 4;
  seam.advertise({
    id: pipeId,
    pixelFormat: "RGBA8",
    dtype: "U8",
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    channels,
    stride: Math.round(rect.width) * channels,
    bytesPerFrame: Math.round(rect.width) * Math.round(rect.height) * channels,
    ringDepth: 4,
    maxWidth,
    maxHeight,
    maxBytes: maxWidth * maxHeight * channels,
  });
  seam.attach(sourcePipeId, pipeId, { rect });
  return {
    pipeId,
    steer: (r) => seam.steer(pipeId, r),
    retire: () => {
      seam.detach(pipeId);
      seam.unadvertise(pipeId);
    },
  };
}
