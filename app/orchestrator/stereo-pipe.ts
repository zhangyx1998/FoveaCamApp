// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// General-purpose session-owned STEREO DISPARITY node: the first two-input chained
// brick (StereoStream) — SGBM over an L/R pair, publishing a 1-channel CV_32F
// disparity map ("Disparity32F"/F32). Ticks on each LEFT arrival paired with the
// latest RIGHT (latest-wins); output in left-frame coords, params reactive; on-demand
// (zero SGBM cost while parked). Seam-injected (never imports core).
// spec: docs/spec/pipes.md#stereo-pipe

import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";

/** Reactive matcher tuning (all optional — native defaults: 128/5/0 + the
 *  stereo-throughput.md bench winner for the strategy params; the brick rounds
 *  numDisparities up to a multiple of 16 and forces blockSize odd).
 *
 *  Throughput params (stereo-throughput.md):
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

/** The fixed symmetric disparity window (sgbm-signed-range.md): foveated
 *  (independently steered) gaze makes the true L↔R disparity SIGNED and
 *  gaze-dependent, −W…+W — the brick's one-sided 0…+128 default matches
 *  garbage. BOTH attach sites (disparity-scope's free-run node and
 *  multi-fovea's paired node) pass this same window; it is deliberately
 *  STATIC (gaze-centered dynamic retuning is out of scope). Covers gaze
 *  divergence up to ±256 px; beyond that the view degrades again (known
 *  limitation, revisit on the rig). */
export const SIGNED_DISPARITY_WINDOW: Required<
  Pick<StereoParams, "numDisparities" | "minDisparity">
> = {
  numDisparities: 512,
  minDisparity: -256,
};

/** Heatmap normalization PINNED to the window (sgbm-signed-range.md):
 *  min/max = the window's −256…+255, DERIVED from
 *  {@link SIGNED_DISPARITY_WINDOW} so a future window change can't drift the
 *  two apart. Pinning (vs the heatmap's per-frame auto min/max) matters
 *  because the matcher marks invalid pixels `minDisparity − 1` (≈ −257) — the
 *  auto-min locks onto that marker and washes the valid range out; pinned,
 *  invalids CLAMP to the floor color and valid disparities get a stable,
 *  frame-to-frame-consistent colormap (also kills the autoscale flicker).
 *  Shape matches the heatmap brick's reactive `{ min, max }` params. */
export const SIGNED_DISPARITY_HEATMAP_RANGE = {
  min: SIGNED_DISPARITY_WINDOW.minDisparity,
  max:
    SIGNED_DISPARITY_WINDOW.minDisparity +
    SIGNED_DISPARITY_WINDOW.numDisparities -
    1,
} as const;

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

/** The F32 disparity pipe advert — IDENTICAL in both modes (stereo-paired-inputs:
 *  `Disparity32F`, F32, left-sized; heatmap chaining + consumers see
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

/** stereo-paired-inputs: advertise the SAME F32 disparity pipe +
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
