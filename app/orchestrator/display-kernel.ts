// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared DISPLAY vision kernel (calibration-free since C-23): runs INSIDE the vision
// worker, producing the processed views (magnified slice, perspective-wrapped foveae,
// combined diff/depth) + multi-fovea's center relay off the JS event loop. Each session
// ships its calibration-derived matrices as params. real-1g: the C input is the
// undistort:<serial> pipe (already-undistorted), so no in-worker Undistort; process is sync.
// spec: docs/spec/vision.md#display-kernel

import { RECT } from "@lib/util/geometry";
import { makeMat } from "@lib/mat";
import {
  diff,
  disparity,
  depthFromProjection,
  heatmap,
  reprojectImageTo3D,
  resize,
  slice,
  wrapPerspective,
  type Mat,
} from "core/Vision";
import type { Rect } from "core/Geometry";
import { SIGNED_DISPARITY_WINDOW } from "./stereo-pipe.js";
import type { DisplayParams, DisplayValues } from "./display-transport.js";
import type {
  FrameSet,
  KernelFrameOut,
  KernelOutput,
  VisionKernel,
} from "./vision-kernel.js";

// --- depth view matcher window (depth-view-legacy-stereobm, 2026-07-11) -------
// The depth view used to run FULL-RES StereoBM over the legacy UNSIGNED 0…64
// window — duplicating (worse) what the tuned native stereo brick does, and
// inheriting the exact unsigned-window bug disparity-scope fixed
// (sgbm-signed-range.md: independently steered foveae make true disparity
// SIGNED). Chosen fix (effort call, documented): keep the view in this kernel
// but adopt the brick's ruled geometry — the SIGNED_DISPARITY_WINDOW scaled by
// a quarter-res match (the stereo-throughput matchScale default). Full
// native-stereo-pipe routing (disparity-scope's path) needs warped L/R PIPES
// manual-control doesn't build — a session-level replumb with rig-gated
// verification, disproportionate for a preview view; revisit if the depth
// view ever becomes a measurement surface.
const DEPTH_MATCH_SCALE = 4; // match at 1/4 res, window scaled alongside
const DEPTH_WINDOW = {
  // 512/−256 → 128/−64 at quarter scale (multiples of 16 preserved).
  numDisparities: SIGNED_DISPARITY_WINDOW.numDisparities / DEPTH_MATCH_SCALE,
  minDisparity: SIGNED_DISPARITY_WINDOW.minDisparity / DEPTH_MATCH_SCALE,
} as const;
const DEPTH_BLOCK_SIZE = 21; // the legacy block size, unchanged

function toMat(nums: number[] | null | undefined, shape: number[]): Mat<Float64Array> | null {
  const n = shape.reduce((a, b) => a * b, 1);
  if (!nums || nums.length < n) return null;
  return makeMat(new Float64Array(nums.slice(0, n)), shape, 1);
}

export function createDisplayKernel(initial: Record<string, unknown>): VisionKernel {
  const p: {
    homographyL: Mat<Float64Array> | null;
    homographyR: Mat<Float64Array> | null;
    qMatrix: Mat<Float64Array> | null;
    sliceAt: { x: number; y: number } | null;
    zoom: number;
    view: string;
    depthNear: number;
    depthFar: number;
  } = {
    homographyL: null,
    homographyR: null,
    qMatrix: null,
    sliceAt: null,
    zoom: 1,
    view: "sliced",
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

  function fovea(role: "L" | "R", raw: Mat<Uint8Array>): void {
    // The kernel emits NO L/R preview frames anymore (real-2b sweep close:
    // every consumer's L/R view binds a `camera/<serial>/undistort` pipe
    // directly). The warp survives solely as the combined (diff/depth)
    // `aligned` input — sliced view skips it entirely (the hot path).
    const combining = p.view !== "sliced";
    if (combining) {
      const H = role === "L" ? p.homographyL : p.homographyR;
      aligned[role] = H ? wrapPerspective(raw, H) : null; // combined view guards on both
    } else {
      aligned.L = aligned.R = null;
    }
  }

  /** Q with its affine column scaled to the quarter-res match space. With
   *  [X Y Z W]ᵀ = Q·[u v d 1]ᵀ (X = u−cx, Y = v−cy, Z = f, W = b·d + p),
   *  scaling u, v, d by 1/k AND the last column (−cx, −cy, f, p) by 1/k
   *  scales X, Y, Z, W uniformly — the projected X/W, Y/W, Z/W points (and
   *  the depth clamp window) are IDENTICAL to the full-res result. */
  function scaledQ(): Mat<Float64Array> | null {
    if (!p.qMatrix) return null;
    const q = Float64Array.from(p.qMatrix);
    for (const i of [3, 7, 11, 15]) q[i] /= DEPTH_MATCH_SCALE;
    return makeMat(q, [4, 4], 1);
  }

  async function combined(out: KernelFrameOut[]): Promise<void> {
    const { L, R } = aligned;
    if (!L || !R) return;
    if (p.view === "diff") {
      out.push({ name: "center", mat: diff(L, R, true) });
    } else if (p.qMatrix) {
      // Quarter-res SIGNED match (see DEPTH_WINDOW above): ~1/16 the pixels ×
      // 2× the (now correct) search width ≈ 1/8 the old matcher cost, and
      // toed-in gaze no longer matches garbage. The emitted heatmap is
      // quarter-res — a preview surface; FrameView scales at draw.
      const [h = 0, w = 0] = L.shape;
      const size = {
        width: Math.max(16, Math.round(w / DEPTH_MATCH_SCALE)),
        height: Math.max(16, Math.round(h / DEPTH_MATCH_SCALE)),
      };
      const [ls, rs] = await Promise.all([resize(L, size), resize(R, size)]);
      const d = disparity(
        ls,
        rs,
        DEPTH_WINDOW.numDisparities,
        DEPTH_BLOCK_SIZE,
        DEPTH_WINDOW.minDisparity,
      );
      const proj = reprojectImageTo3D(d, scaledQ()!);
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
      if (d.depthNear !== undefined) p.depthNear = d.depthNear;
      if (d.depthFar !== undefined) p.depthFar = d.depthFar;
    },

    async process(frames: FrameSet): Promise<KernelOutput> {
      const out: KernelFrameOut[] = [];
      const values: DisplayValues = {};
      if (frames.C) {
        // Already undistorted (the `undistort:<serial>` pipe input, real-1g) —
        // or raw on an uncalibrated rig (session fell back to `camera:<serial>`,
        // matching the old `undistort ? apply : raw` degradation).
        const view = frames.C.mat;
        const [h = 0, w = 0] = view.shape;
        if (w !== width || h !== height) {
          width = w;
          height = h;
          values.size = { width: w, height: h };
        }
        if (p.view === "sliced" && width && height) {
          const zoom = Math.max(1, p.zoom);
          const size = { width: width / zoom, height: height / zoom };
          const at = p.sliceAt ?? { x: width / 2, y: height / 2 };
          out.push({ name: "center", mat: slice(view, clampRect(RECT.fromCenter(at, size))) });
        }
      }
      if (frames.L) fovea("L", frames.L.mat);
      if (frames.R) {
        fovea("R", frames.R.mat);
        if (p.view !== "sliced") await combined(out);
      }
      if (out.length === 0 && values.size === undefined) return null;
      return { values, frames: out };
    },

    dispose(): void {
      aligned.L = aligned.R = null;
    },
  };

  kernel.setParams(initial); // apply the init params (same merge path)
  return kernel;
}
