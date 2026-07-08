// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-distortion VISION KERNEL (C-22b step 3) — the L/R projection warp
// moved off the JS event loop. Main runs the `MarkerTracker`s (native streams)
// and, on each fovea detection, computes the projection homography (a cheap
// 4-point `findHomography`) and ships it as a param; this kernel does the heavy
// `wrapPerspective` on the fovea frame it reads from the pipe, posting only the
// warped alignment-check overlay. (C-2c: the raw fovea preview is no longer
// relayed here — the renderer reads the native `camera:<serial>` convert pipe
// directly, so this kernel no longer passthrough-gates the L/R view fps.)

import { makeMat } from "@lib/mat";
import { wrapPerspective, type Mat } from "core/Vision";
import type {
  FrameSet,
  KernelFrameOut,
  KernelOutput,
  VisionKernel,
} from "@orchestrator/vision-kernel";

/** Projection homographies main ships per fovea detection (9 flat numbers, or
 *  null before the first detection). */
export type DistortionParams = { homographyL?: number[] | null; homographyR?: number[] | null };

function toH(nums: number[] | null | undefined): Mat<Float64Array> | null {
  if (!nums || nums.length < 9) return null;
  return makeMat(new Float64Array(nums.slice(0, 9)), [3, 3], 1);
}

export function createDistortionKernel(initial: Record<string, unknown>): VisionKernel {
  const p: { homographyL: Mat<Float64Array> | null; homographyR: Mat<Float64Array> | null } = {
    homographyL: null,
    homographyR: null,
  };

  function foveaOut(role: "L" | "R", raw: Mat<Uint8Array>, out: KernelFrameOut[]): void {
    // Only the worker-derived warped overlay is posted (renderer binds
    // session.frame(`proj_${role}`)); the raw preview rides the convert pipe.
    const H = role === "L" ? p.homographyL : p.homographyR;
    if (H) out.push({ name: `proj_${role}`, mat: wrapPerspective(raw, H) });
  }

  const kernel: VisionKernel = {
    setParams(params: Record<string, unknown>): void {
      const d = params as DistortionParams;
      if ("homographyL" in d) p.homographyL = toH(d.homographyL);
      if ("homographyR" in d) p.homographyR = toH(d.homographyR);
    },
    process(frames: FrameSet): KernelOutput {
      const out: KernelFrameOut[] = [];
      if (frames.L) foveaOut("L", frames.L.mat, out);
      if (frames.R) foveaOut("R", frames.R.mat, out);
      return out.length ? { values: {}, frames: out } : null;
    },
    dispose(): void {
      p.homographyL = p.homographyR = null;
    },
  };
  kernel.setParams(initial);
  return kernel;
}
