// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// General-purpose template-match vision kernel: one `needle` pipe correlated into
// one `haystack` pipe, nothing app-specific inside. Inputs arrive pre-sized (scale
// nodes own geometry); output is haystack-local rect/score/origin that lifts to
// absolute source coords; the emitted heatmap is padded back to haystack dims for
// the debugger's column cross-reference. Used by disparity-scope (match/L, match/R).
// spec: docs/spec/vision.md#template-match

import type { Rect } from "core/Geometry";
import { cvtColor, gaussian, heatmap, matchTemplate, minMaxLoc, slice, type Mat } from "core/Vision";
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
  /** Emit the smoothed correlation map as the `match` heatmap frame, padded
   *  (zero-filled out-of-bounds `slice`) to the haystack's dims so pixel (x,y)
   *  is the needle CENTERED at haystack (x,y) — haystack-column-aligned for a
   *  diagnostic stacked under the strip. The scalar peak stays map-local. */
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

// TEMP size-trace (debug — remove): first-sight/on-change cache for the final
// hops (needle/haystack grayscale) + the matchTemplate call site.
const __sizeTraceSeen = new Map<string, string>();
function __sizeTrace(key: string, line: string): void {
  if (__sizeTraceSeen.get(key) === line) return;
  __sizeTraceSeen.set(key, line);
  console.log(`[size-trace] ${line}`);
}

export function createTemplateMatchKernel(
  initial: Record<string, unknown>,
): VisionKernel {
  // TEMP size-trace (debug — remove): per-side label injected by the worker.
  const traceLabel = String(initial.__traceMeter ?? "match");
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
      // TEMP size-trace (debug — remove): the NEEDLE input frame + its grayscale
      // (the retained tile), immediately before the match.
      if (needle && tile)
        __sizeTrace(
          `needle/${traceLabel}`,
          `needle-in[${traceLabel}] ${needle.mat.shape[1]}x${needle.mat.shape[0]} ch=${needle.mat.channels} ` +
            `-> needle-gray ${tile.shape[1]}x${tile.shape[0]} ch=${tile.channels}`,
        );
      const hay = frames.haystack;
      if (!hay || !tile) return null;
      const strip = cvtColor(hay.mat, "RGBA2GRAY");
      const [th = 0, tw = 0] = tile.shape;
      const [sh = 0, sw = 0] = strip.shape;
      // TEMP size-trace (debug — remove): the GUIDE/haystack input frame + its
      // grayscale strip.
      __sizeTrace(
        `guide/${traceLabel}`,
        `haystack-in(guide)[${traceLabel}] ${hay.mat.shape[1]}x${hay.mat.shape[0]} ch=${hay.mat.channels} ` +
          `-> haystack-gray ${sw}x${sh} ch=${strip.channels}`,
      );
      // A needle larger than the haystack cannot be matched (transient while
      // the caller retunes the scalers) — skip the tick rather than throw.
      if (tw < 1 || th < 1 || tw > sw || th > sh) return null;
      // TEMP size-trace (debug — remove): the actual matchTemplate call site.
      __sizeTrace(
        `matchTemplate/${traceLabel}`,
        `matchTemplate[${traceLabel}] needle ${tw}x${th} vs guide ${sw}x${sh} method=CCOEFF_NORMED`,
      );
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
      // Pad the (post-gaussian) placement-space map to the haystack dims for
      // the emitted frame ONLY: the out-of-bounds `slice` zero-fills the border
      // (core Vision.cpp fills out-of-range with zeros — neutral mid color in
      // the heatmap), and the -floor(t/2) offset recenters the needle so pixel
      // (x,y) = the needle CENTERED at haystack (x,y). `values` above already
      // read the peak off the unpadded `map`, so the shift never touches it.
      const out: KernelFrameOut[] = p.emitHeatmap
        ? [
            {
              name: "match",
              mat: heatmap(
                slice(map, {
                  x: -Math.floor(tw / 2),
                  y: -Math.floor(th / 2),
                  width: sw,
                  height: sh,
                }),
              ),
            },
          ]
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
