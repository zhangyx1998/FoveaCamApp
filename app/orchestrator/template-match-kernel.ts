// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// GENERAL-PURPOSE template-match vision kernel (split-disparity-nodes
// proposal, ruled 2026-07-09). One `needle` pipe correlated into one
// `haystack` pipe — nothing app-specific inside:
//
//  - Both inputs arrive PRE-SIZED (ruling 5): a scale node in front of each
//    input owns all geometry, so this kernel does NO resizing — the caller
//    computes tile/strip sizing (e.g. disparity's foveaTileSize /
//    matchMagnification) and retunes the scalers.
//  - Each HAYSTACK arrival drives one match tick (the needle is retained
//    across ticks, refreshed whenever its pipe produces).
//  - Output is haystack-LOCAL: `rect` (the matched needle footprint in the
//    haystack frame's pixels) + `score` (CCOEFF_NORMED peak) + `origin` (the
//    haystack frame's frame-bound crop origin, forwarded by the slice/scale
//    chain in the v4 slot header). `origin + rect-center / <caller's
//    downsample>` lifts a match to ABSOLUTE source-frame coordinates — the
//    kernel never needs a target, and no app state rides its params.
//
// Used by disparity-scope twice (match/L, match/R); reusable by anything
// that needs "where does this tile sit in that stream".

import type { Rect } from "core/Geometry";
import { cvtColor, gaussian, heatmap, matchTemplate, minMaxLoc, type Mat } from "core/Vision";
import { RECT } from "@lib/util/geometry";
import type { FrameSet, KernelFrameOut, KernelOutput, VisionKernel } from "./vision-kernel.js";

/** Params — smoothing/diagnostics only (ruling 5: geometry lives in the
 *  scale nodes in front of this kernel). */
export type TemplateMatchParams = {
  kind?: "template-match";
  /** Correlation-map Gaussian smoothing before peak-finding (a single noisy
   *  pixel must not win over a broader lobe). 0 disables. */
  gaussKsize?: number;
  gaussSigma?: number;
  /** Emit the smoothed correlation map as the `match` heatmap frame. */
  emitHeatmap?: boolean;
};

/** Worker→main scalar results for one match tick. */
export type TemplateMatchValues = {
  /** Matched needle footprint, HAYSTACK-local pixels (the haystack's own —
   *  possibly scaled — space; the caller owns the un-scale). */
  rect: Rect;
  /** CCOEFF_NORMED peak in [-1, 1]; higher = more confident. */
  score: number;
  /** The haystack frame's frame-bound crop origin (source full-res
   *  coordinates, forwarded unscaled by the slice/scale chain). */
  origin: { x: number; y: number };
  seq?: number;
  deviceTimestamp?: number;
};

const DEFAULT_GAUSS_KSIZE = 9;
const DEFAULT_GAUSS_SIGMA = 10;

export function createTemplateMatchKernel(
  initial: Record<string, unknown>,
): VisionKernel {
  const p: Required<Omit<TemplateMatchParams, "kind">> = {
    gaussKsize: DEFAULT_GAUSS_KSIZE,
    gaussSigma: DEFAULT_GAUSS_SIGMA,
    emitHeatmap: true,
  };

  // The retained needle tile (grayscale). `cvtColor` allocates a fresh buffer
  // before this function's first await, so retaining its output past the
  // `process` call is safe even though the worker reuses the read buffer
  // (same reasoning the old getFoveaTile documented).
  let tile: Mat<Uint8Array> | null = null;

  const kernel: VisionKernel = {
    setParams(params: Record<string, unknown>): void {
      const d = params as TemplateMatchParams;
      if (d.gaussKsize !== undefined) p.gaussKsize = d.gaussKsize;
      if (d.gaussSigma !== undefined) p.gaussSigma = d.gaussSigma;
      if (d.emitHeatmap !== undefined) p.emitHeatmap = d.emitHeatmap;
    },

    async process(frames: FrameSet): Promise<KernelOutput> {
      const needle = frames.needle;
      if (needle) tile = cvtColor(needle.mat, "RGBA2GRAY");
      const hay = frames.haystack;
      if (!hay || !tile) return null;
      const strip = cvtColor(hay.mat, "RGBA2GRAY");
      const [th = 0, tw = 0] = tile.shape;
      const [sh = 0, sw = 0] = strip.shape;
      // A needle larger than the haystack cannot be matched (transient while
      // the caller retunes the scalers) — skip the tick rather than throw.
      if (tw < 1 || th < 1 || tw > sw || th > sh) return null;
      let map = await matchTemplate(strip, tile, "CCOEFF_NORMED");
      if (p.gaussKsize > 0) map = gaussian(map, p.gaussKsize, p.gaussSigma);
      const { max } = minMaxLoc(map);
      const values: TemplateMatchValues = {
        rect: RECT.fromTopLeft(max, { width: tw, height: th }),
        score: max.value,
        origin: { x: hay.originX ?? 0, y: hay.originY ?? 0 },
        seq: hay.seq,
        deviceTimestamp: hay.deviceTimestamp,
      };
      const out: KernelFrameOut[] = p.emitHeatmap
        ? [{ name: "match", mat: heatmap(map) }]
        : [];
      return { values: values as unknown as Record<string, unknown>, frames: out };
    },

    dispose(): void {
      tile = null; // GC-managed
    },
  };

  kernel.setParams(initial);
  return kernel;
}
