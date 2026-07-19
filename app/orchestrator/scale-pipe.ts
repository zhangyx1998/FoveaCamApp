// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// General-purpose session-owned scale/resize node: a native chained brick
// (`ScaleStream`) that resizes a source pipe's frames into its own
// variable-size pipe. One reactive sizing param (ratio/dwidth/dheight/dsize),
// output dims recomputed per frame from the active input dims; the crop origin is
// forwarded unscaled. Seam-injected (never imports core).
// spec: docs/spec/pipes.md#scale-pipe

import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";

/** Exactly one sizing mode (the native brick rejects ambiguous params). */
export type ScaleParams =
  | { ratio: number }
  | { dwidth: number }
  | { dheight: number }
  | { dsize: { width: number; height: number } };

export interface ScalePipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  attach(sourcePipeId: string, pipeId: string, params: ScaleParams): void;
  retune(pipeId: string, params: ScaleParams): void;
  detach(pipeId: string): void;
}

export interface ScalePipeOptions {
  params: ScaleParams;
  /** Ring footprint (max dims — a later `retune` may grow the output up
   *  to this; the native brick clamps beyond it). */
  maxWidth: number;
  maxHeight: number;
  /** Advertised nominal dims (display hint; frames carry their ACTIVE dims).
   *  Defaults to the max footprint. */
  width?: number;
  height?: number;
}

export interface ScaleHandle {
  readonly pipeId: string;
  /** Reactively retune the sizing (applied on the next frame). */
  retune(params: ScaleParams): void;
  /** Detach the producer + un-advertise (consumers see CLOSED). */
  retire(): void;
}

/** Advertise the max-footprint pipe + attach the scale brick chained on
 *  `sourcePipeId`. Advertise BEFORE attach. */
export function createScalePipe(
  seam: ScalePipeSeam,
  sourcePipeId: string,
  pipeId: string,
  opts: ScalePipeOptions,
): ScaleHandle {
  const { params, maxWidth, maxHeight } = opts;
  const width = Math.round(opts.width ?? maxWidth);
  const height = Math.round(opts.height ?? maxHeight);
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
    maxWidth,
    maxHeight,
    maxBytes: maxWidth * maxHeight * channels,
  });
  seam.attach(sourcePipeId, pipeId, params);
  return {
    pipeId,
    retune: (p) => seam.retune(pipeId, p),
    retire: () => {
      seam.detach(pipeId);
      seam.unadvertise(pipeId);
    },
  };
}
