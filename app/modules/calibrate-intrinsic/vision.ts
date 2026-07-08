// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-intrinsic CHECKER VISION KERNEL (C-22b step 3) — checkerboard
// detection moved off the JS event loop. Reads the active camera's pipe,
// converts to grayscale, and runs `findChessboardCorners`. It posts the corner
// points (values) AND the gray frame (so main can retain the exact detected
// frame for `cornerSubPix`/`calibrateCamera` at capture time). MARKER mode is
// unchanged — it runs `detector.stream` on its own, already off the loop.

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
      const gray: Mat<Uint8Array> = cvtColor(raw, "BGRA2GRAY");
      const corners = await findChessboardCorners(gray, {
        width: p.patternWidth,
        height: p.patternHeight,
      });
      if (corners.length > 0) {
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
