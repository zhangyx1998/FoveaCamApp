// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// GENERAL-PURPOSE session-owned STEREO DISPARITY node (stereo-disparity-and-
// heatmap-nodes, ruled 2026-07-09): the first TWO-INPUT chained brick
// (`StereoStream`) — SGBM over a left/right pair of frame pipes, publishing a
// single-channel CV_32F disparity map as its own C-20 pipe
// (`pixelFormat: "Disparity32F"`, `dtype: "F32"`).
//
// Ticks on every LEFT arrival paired with the LATEST RIGHT frame (latest-wins
// on both taps — no cross-camera seq comparison); disparity is in LEFT-frame
// coordinates and the left frame's timestamps/origin are forwarded. Params
// are REACTIVE (`retune`, applied on the next tick, no re-attach).
//
// ON-DEMAND (ruling 2) is the ChainedStream contract: the brick runs iff its
// pipe has consumers (or a downstream tap — the heatmap brick — subscribes);
// parked, its SGBM cost is exactly zero.
//
// Seam-injected (never imports native core) — index.ts wires
// `Aravis.attachStereoPipe`/`setStereoParams`/`detachStereoPipe`.

import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";

/** Reactive SGBM tuning (all optional — native defaults: 128/5/0; the brick
 *  rounds numDisparities up to a multiple of 16 and forces blockSize odd). */
export type StereoParams = {
  numDisparities?: number;
  blockSize?: number;
  minDisparity?: number;
};

export interface StereoPipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  attach(
    leftPipeId: string,
    rightPipeId: string,
    pipeId: string,
    params: StereoParams,
  ): void;
  retune(pipeId: string, params: StereoParams): void;
  detach(pipeId: string): void;
}

export interface StereoPipeOptions {
  params?: StereoParams;
  /** Ring footprint = the LEFT source's max dims (disparity is left-sized). */
  maxWidth: number;
  maxHeight: number;
}

export interface StereoHandle {
  readonly pipeId: string;
  /** Reactively retune the SGBM params (applied on the next tick). */
  retune(params: StereoParams): void;
  /** Detach the producer + un-advertise (consumers see CLOSED). */
  retire(): void;
}

const F32_BYTES = 4;

/** Advertise the F32 disparity pipe + attach the stereo brick chained on the
 *  two source pipes. Advertise BEFORE attach. */
export function createStereoPipe(
  seam: StereoPipeSeam,
  leftPipeId: string,
  rightPipeId: string,
  pipeId: string,
  opts: StereoPipeOptions,
): StereoHandle {
  const { maxWidth, maxHeight } = opts;
  seam.advertise({
    id: pipeId,
    pixelFormat: "Disparity32F",
    dtype: "F32",
    width: maxWidth,
    height: maxHeight,
    channels: 1,
    stride: maxWidth * F32_BYTES,
    bytesPerFrame: maxWidth * maxHeight * F32_BYTES,
    ringDepth: 4,
    maxWidth,
    maxHeight,
    maxBytes: maxWidth * maxHeight * F32_BYTES,
  });
  seam.attach(leftPipeId, rightPipeId, pipeId, opts.params ?? {});
  return {
    pipeId,
    retune: (p) => seam.retune(pipeId, p),
    retire: () => {
      seam.detach(pipeId);
      seam.unadvertise(pipeId);
    },
  };
}
