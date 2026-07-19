// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// General-purpose session-owned HEATMAP node: a native chained brick (HeatmapStream)
// that colormaps a 1-channel source pipe (CV_32F or CV_8U — the stereo disparity map
// is the flagship input) to an RGBA8 pipe (COLORMAP_TURBO). Normalization reactive
// (explicit {min,max} or per-frame auto). On-demand: its tap keeps the upstream SGBM
// chain awake, so connecting/disconnecting this pipe starts/stops it. Never imports core.
// spec: docs/spec/pipes.md#heatmap-pipe

import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";

/** Reactive normalization bounds — an absent field auto-normalizes from that
 *  frame's own min/max. */
export type HeatmapParams = {
  min?: number;
  max?: number;
};

export interface HeatmapPipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  attach(sourcePipeId: string, pipeId: string, params: HeatmapParams): void;
  retune(pipeId: string, params: HeatmapParams): void;
  detach(pipeId: string): void;
}

export interface HeatmapPipeOptions {
  params?: HeatmapParams;
  /** Ring footprint (max dims — the source's max footprint). */
  maxWidth: number;
  maxHeight: number;
}

export interface HeatmapHandle {
  readonly pipeId: string;
  /** Reactively retune the normalization (applied on the next frame). */
  retune(params: HeatmapParams): void;
  /** Detach the producer + un-advertise (consumers see CLOSED). */
  retire(): void;
}

/** Advertise the RGBA8 pipe + attach the heatmap brick chained on
 *  `sourcePipeId`. Advertise BEFORE attach. */
export function createHeatmapPipe(
  seam: HeatmapPipeSeam,
  sourcePipeId: string,
  pipeId: string,
  opts: HeatmapPipeOptions,
): HeatmapHandle {
  const { maxWidth, maxHeight } = opts;
  const channels = 4;
  seam.advertise({
    id: pipeId,
    pixelFormat: "RGBA8",
    dtype: "U8",
    width: maxWidth,
    height: maxHeight,
    channels,
    stride: maxWidth * channels,
    bytesPerFrame: maxWidth * maxHeight * channels,
    ringDepth: 4,
    maxWidth,
    maxHeight,
    maxBytes: maxWidth * maxHeight * channels,
  });
  seam.attach(sourcePipeId, pipeId, opts.params ?? {});
  return {
    pipeId,
    retune: (p) => seam.retune(pipeId, p),
    retire: () => {
      seam.detach(pipeId);
      seam.unadvertise(pipeId);
    },
  };
}
