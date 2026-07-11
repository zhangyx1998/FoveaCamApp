// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-intrinsic CHECKER vision kernel — grayscale + `findChessboardCorners`
// off the JS loop, posting the corner points AND the gray frame (main retains it
// for the capture-time solve). See docs/spec/calibrate-intrinsic.md §detection.

import { cvtColor, findChessboardCorners, type Mat } from "core/Vision";
import type {
  FrameSet,
  KernelOutput,
  VisionKernel,
} from "@orchestrator/vision-kernel";

/** The configured checkerboard pattern size. */
export type CheckerParams = { patternWidth?: number; patternHeight?: number };

/** Worker→main: detected corners (null when none) + learned geometry. The gray
 *  frame rides the frames array (`name: "gray"`), retained by main for capture. */
export type CheckerValues = {
  points?: { x: number; y: number }[] | null;
  size?: { width: number; height: number };
};

export function createCheckerKernel(initial: Record<string, unknown>): VisionKernel {
  const p: { patternWidth: number; patternHeight: number } = {
    patternWidth: 9,
    patternHeight: 6,
  };
  let width = 0;
  let height = 0;

  const kernel: VisionKernel = {
    setParams(params: Record<string, unknown>): void {
      const d = params as CheckerParams;
      if (d.patternWidth !== undefined) p.patternWidth = d.patternWidth;
      if (d.patternHeight !== undefined) p.patternHeight = d.patternHeight;
    },
    async process(frames: FrameSet): Promise<KernelOutput> {
      // Single-camera session: whichever pipe arrives (role tagged "C").
      const f = frames.C ?? frames.L ?? frames.R;
      if (!f) return null;
      const raw = f.mat;
      const [h = 0, w = 0] = raw.shape;
      const values: CheckerValues = {};
      if (w !== width || h !== height) {
        width = w;
        height = h;
        values.size = { width: w, height: h };
      }
      // The shared preview is honest RGBA8 (channel-order-fix.md).
      const gray: Mat<Uint8Array> = cvtColor(raw, "RGBA2GRAY");
      const corners = await findChessboardCorners(gray, {
        width: p.patternWidth,
        height: p.patternHeight,
      });
      // COMPLETE-board gate (calibration-review-2026-07-11 #11): the native
      // seam discards `findChessboardCorners`' found-boolean, whose contract is
      // "all W×H corners located, in order". A partial detection used to be
      // capturable and then rejected the WHOLE solve with an opaque
      // count-mismatch — treat anything but exactly W×H corners as no detection.
      if (corners.length === p.patternWidth * p.patternHeight) {
        values.points = corners;
        return { values, frames: [{ name: "gray", mat: gray }] };
      }
      values.points = null;
      return { values, frames: [] };
    },
    dispose(): void {},
  };
  kernel.setParams(initial);
  return kernel;
}
