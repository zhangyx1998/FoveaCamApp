// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// GENERAL-PURPOSE session-owned SCALE/RESIZE node (split-disparity-nodes
// ruling 5, 2026-07-09): a native chained brick (`ScaleStream`) that resizes
// a source pipe's frames and publishes them as its own C-20 variable-size
// pipe. The param is REACTIVE (`retune`, applied on the next frame, no
// re-attach) and is exactly ONE of:
//
//   { ratio }   — out = in × ratio
//   { dwidth }  — fixed output width, height follows the input aspect
//   { dheight } — fixed output height, width follows the input aspect
//   { dsize }   — exact output width × height
//
// Output dims are recomputed PER FRAME from the params + that frame's ACTIVE
// input dims (variable-size sources — e.g. a slice pipe — just work). The
// source frame's crop ORIGIN is forwarded UNSCALED (source full-res
// coordinates): consumers un-scale their local coords with the ratio they
// commanded, then add the origin.
//
// disparity-scope puts one in front of each template-match input (the match
// guide strip and the fovea needle), so the match kernel does no resizing.
//
// Seam-injected (never imports native core) — index.ts wires
// `Aravis.attachScalePipe`/`setScaleParams`/`detachScalePipe`.

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
  /** Ring footprint (C-20 max dims — a later `retune` may grow the output up
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

/** Advertise the C-20 max-footprint pipe + attach the scale brick chained on
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
    pixelFormat: "BGRA8",
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
