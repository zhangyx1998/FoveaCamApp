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

/** Reactive matcher tuning (all optional — native defaults: 128/5/0 + the
 *  stereo-throughput.md bench winner for the strategy params; the brick rounds
 *  numDisparities up to a multiple of 16 and forces blockSize odd).
 *
 *  Throughput params (stereo-throughput.md, ruled 2026-07-10):
 *  - `algorithm` — "sgbm" (default) or the faster classic "bm" (StereoBM).
 *  - `mode`      — SGBM variant: "sgbm" | "3way" (default) | "hh".
 *  - `matchScale`— 1 | 2 | 4 (default 4): match at 1/scale resolution with the
 *                  window scaled alongside; disparity VALUES stay in FULL-RES
 *                  left-frame pixel units, but the emitted MAP DIMENSIONS are
 *                  at match scale (consumers must not assume full-res).
 *  - `wls`       — cv::ximgproc WLS guided refine (+`wlsLambda`/`wlsSigma`);
 *                  a build without opencv_contrib degrades it to a no-op. */
export type StereoParams = {
  numDisparities?: number;
  blockSize?: number;
  minDisparity?: number;
  algorithm?: "sgbm" | "bm";
  mode?: "sgbm" | "3way" | "hh";
  matchScale?: 1 | 2 | 4;
  wls?: boolean;
  wlsLambda?: number;
  wlsSigma?: number;
};

/** The RULED fixed symmetric disparity window (sgbm-signed-range.md,
 *  2026-07-10): foveated (independently steered) gaze makes the true L↔R
 *  disparity SIGNED and gaze-dependent, −W…+W — the brick's one-sided 0…+128
 *  default matched garbage. BOTH attach sites (disparity-scope's free-run node
 *  and multi-fovea's paired node) pass this same window; it is deliberately
 *  STATIC (gaze-centered dynamic retuning was ruled out). Covers gaze
 *  divergence up to ±256 px; beyond that the view degrades again (known
 *  limitation, revisit on the rig). */
export const SIGNED_DISPARITY_WINDOW: StereoParams = {
  numDisparities: 512,
  minDisparity: -256,
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
  /** stereo-paired-inputs: attach the PAIRED variant — SGBM per exposure pair
   *  off the always-running pairing brick (`pair/<stage>`), matched L/R by
   *  construction. Same output advert + on-demand gate as `attach`. */
  attachPaired(pairStage: string, pipeId: string, params: StereoParams): void;
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

/** The F32 disparity pipe advert — IDENTICAL in both modes (stereo-paired-inputs
 *  ruling 4: `Disparity32F`, F32, left-sized; heatmap chaining + consumers see
 *  no difference between latest-wins and paired). */
function advertiseDisparity(seam: StereoPipeSeam, pipeId: string, opts: StereoPipeOptions): void {
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
}

function stereoHandle(seam: StereoPipeSeam, pipeId: string): StereoHandle {
  return {
    pipeId,
    retune: (p) => seam.retune(pipeId, p),
    retire: () => {
      seam.detach(pipeId);
      seam.unadvertise(pipeId);
    },
  };
}

/** Advertise the F32 disparity pipe + attach the LATEST-WINS stereo brick
 *  chained on the two source pipes (free-run). Advertise BEFORE attach. */
export function createStereoPipe(
  seam: StereoPipeSeam,
  leftPipeId: string,
  rightPipeId: string,
  pipeId: string,
  opts: StereoPipeOptions,
): StereoHandle {
  advertiseDisparity(seam, pipeId, opts);
  seam.attach(leftPipeId, rightPipeId, pipeId, opts.params ?? {});
  return stereoHandle(seam, pipeId);
}

/** stereo-paired-inputs (ruling 1/2): advertise the SAME F32 disparity pipe +
 *  attach the PAIRED stereo brick chained on the pairing brick (`pair/<stage>`).
 *  Composed when the session's trigger topology is live; the advert + returned
 *  handle are identical to `createStereoPipe` (consumers/heatmap unchanged). */
export function createPairedStereoPipe(
  seam: StereoPipeSeam,
  pairStage: string,
  pipeId: string,
  opts: StereoPipeOptions,
): StereoHandle {
  advertiseDisparity(seam, pipeId, opts);
  seam.attachPaired(pairStage, pipeId, opts.params ?? {});
  return stereoHandle(seam, pipeId);
}
