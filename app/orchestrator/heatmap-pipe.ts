// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// GENERAL-PURPOSE session-owned HEATMAP node (stereo-disparity-and-heatmap-
// nodes, ruled 2026-07-09): a native chained brick (`HeatmapStream`) that
// colormaps a 1-channel source pipe (CV_32F or CV_8U — the stereo brick's
// disparity map is the flagship input) to a RGBA8 pipe (COLORMAP_TURBO).
//
// Normalization is REACTIVE (`retune`): explicit `{min, max}` bounds, or
// absent → per-frame min/max auto-normalize. Active dims + origin +
// timestamps are forwarded from the source frame (trusted-time).
//
// ON-DEMAND (ruling 2): the brick runs iff its pipe has consumers; while it
// runs, its tap keeps the upstream (stereo) brick awake — the renderer
// connecting/disconnecting this one pipe starts/stops the whole SGBM chain.
//
// Seam-injected (never imports native core) — index.ts wires
// `Aravis.attachHeatmapPipe`/`setHeatmapParams`/`detachHeatmapPipe`.

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
  /** Ring footprint (C-20 max dims — the source's max footprint). */
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
