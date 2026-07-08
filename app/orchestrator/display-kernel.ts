// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared DISPLAY vision kernel (C-22b step 2) — runs INSIDE the vision worker,
// producing tracking-single + manual-control's processed views off the JS event
// loop. Both apps had byte-identical view math (undistorted center + magnified
// slice, perspective-wrapped foveae, combined diff/depth), so one kernel serves
// both; each session computes its own matrices/scalars on the main thread and
// ships them as params (fovea homographies, depth Q-matrix, slice center).
//
// The only calibration reconstructed here is `new Undistort(cal)` for the
// center remap (`apply`) — there's no serializable-matrix shortcut for a full
// distortion remap. All display ops are synchronous, so `process` is sync.

import { RECT } from "@lib/util/geometry";
import { makeMat } from "@lib/mat";
import {
  Undistort,
  diff,
  disparity,
  depthFromProjection,
  heatmap,
  reprojectImageTo3D,
  slice,
  wrapPerspective,
  type Mat,
} from "core/Vision";
import type { Rect } from "core/Geometry";
import {
  deserializeCalibration,
  type DisplayInit,
  type DisplayParams,
  type DisplayValues,
} from "./display-transport.js";
import type {
  FrameSet,
  KernelFrameOut,
  KernelOutput,
  VisionKernel,
} from "./vision-kernel.js";

function toMat(nums: number[] | null | undefined, shape: number[]): Mat<Float64Array> | null {
  const n = shape.reduce((a, b) => a * b, 1);
  if (!nums || nums.length < n) return null;
  return makeMat(new Float64Array(nums.slice(0, n)), shape, 1);
}

export function createDisplayKernel(initial: Record<string, unknown>): VisionKernel {
  let undistort: Undistort | null = null;
  const cal = (initial as DisplayInit).cal;
  if (cal) {
    try {
      undistort = new Undistort(deserializeCalibration(cal));
    } catch {
      undistort = null; // fall back to raw center (matches the sessions' guard)
    }
  }

  const p: {
    homographyL: Mat<Float64Array> | null;
    homographyR: Mat<Float64Array> | null;
    qMatrix: Mat<Float64Array> | null;
    sliceAt: { x: number; y: number } | null;
    zoom: number;
    view: string;
    wrap: boolean;
    depthNear: number;
    depthFar: number;
  } = {
    homographyL: null,
    homographyR: null,
    qMatrix: null,
    sliceAt: null,
    zoom: 1,
    view: "sliced",
    wrap: false,
    depthNear: -Infinity,
    depthFar: Infinity,
  };

  let width = 0;
  let height = 0;
  const aligned: { L: Mat<Uint8Array> | null; R: Mat<Uint8Array> | null } = { L: null, R: null };

  function clampRect(r: Rect): Rect {
    const x = Math.max(0, Math.min(r.x, width));
    const y = Math.max(0, Math.min(r.y, height));
    return {
      x,
      y,
      width: Math.max(1, Math.min(r.width, width - x)),
      height: Math.max(1, Math.min(r.height, height - y)),
    };
  }

  function fovea(role: "L" | "R", raw: Mat<Uint8Array>, out: KernelFrameOut[]): void {
    const H = role === "L" ? p.homographyL : p.homographyR;
    const wrapped = H ? wrapPerspective(raw, H) : null;
    out.push({ name: role, mat: p.wrap && wrapped ? wrapped : raw });
    if (p.view === "sliced") {
      aligned.L = aligned.R = null;
    } else {
      aligned[role] = wrapped; // fresh Mat or null; combined view guards on both
    }
  }

  function combined(out: KernelFrameOut[]): void {
    const { L, R } = aligned;
    if (!L || !R) return;
    if (p.view === "diff") {
      out.push({ name: "center", mat: diff(L, R, true) });
    } else if (p.qMatrix) {
      const proj = reprojectImageTo3D(disparity(L, R), p.qMatrix);
      const z = depthFromProjection(proj, p.depthNear, p.depthFar);
      out.push({ name: "center", mat: heatmap(z) });
    }
  }

  const kernel: VisionKernel = {
    setParams(params: Record<string, unknown>): void {
      const d = params as DisplayParams;
      if ("homographyL" in d) p.homographyL = toMat(d.homographyL, [3, 3]);
      if ("homographyR" in d) p.homographyR = toMat(d.homographyR, [3, 3]);
      if ("qMatrix" in d) p.qMatrix = toMat(d.qMatrix, [4, 4]);
      if (d.sliceAt !== undefined) p.sliceAt = d.sliceAt;
      if (d.zoom !== undefined) p.zoom = d.zoom;
      if (d.view !== undefined) p.view = d.view;
      if (d.wrap !== undefined) p.wrap = d.wrap;
      if (d.depthNear !== undefined) p.depthNear = d.depthNear;
      if (d.depthFar !== undefined) p.depthFar = d.depthFar;
    },

    process(frames: FrameSet): KernelOutput {
      const out: KernelFrameOut[] = [];
      const values: DisplayValues = {};
      if (frames.C) {
        const raw = frames.C.mat;
        const view = undistort ? undistort.apply(raw) : raw;
        const [h = 0, w = 0] = view.shape;
        if (w !== width || h !== height) {
          width = w;
          height = h;
          values.size = { width: w, height: h };
        }
        out.push({ name: "C", mat: view });
        if (p.view === "sliced" && width && height) {
          const zoom = Math.max(1, p.zoom);
          const size = { width: width / zoom, height: height / zoom };
          const at = p.sliceAt ?? { x: width / 2, y: height / 2 };
          out.push({ name: "center", mat: slice(view, clampRect(RECT.fromCenter(at, size))) });
        }
      }
      if (frames.L) fovea("L", frames.L.mat, out);
      if (frames.R) {
        fovea("R", frames.R.mat, out);
        if (p.view !== "sliced") combined(out);
      }
      if (out.length === 0 && values.size === undefined) return null;
      return { values, frames: out };
    },

    dispose(): void {
      undistort = null;
      aligned.L = aligned.R = null;
    },
  };

  kernel.setParams(initial); // apply the init params (same merge path)
  return kernel;
}
