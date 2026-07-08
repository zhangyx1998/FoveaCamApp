// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disparity-scope VISION KERNEL (C-22b, WS1 real-1f) — the pixel half of the
// auto-vergence loop, moved off the orchestrator JS event loop into the vision
// worker thread (`@orchestrator/vision-worker`). It runs INSIDE that worker:
// it SHM-reads L/C/R (the worker frames it), and per tick does
//   - per fovea: `wrapPerspective` onto its current pose (homography sent by
//     main as 9 numbers — worker needs no calibration reconstruction), a
//     grayscale downsampled match tile (`getFoveaTile`), and the "disparity"
//     combined `diff` view;
//   - center: synchronous `KCF` auto-follow (single-threaded loop, so the
//     async-kcf busy-drop/staleness dance dissolves — see the deleted
//     `@orchestrator/async-kcf`), the "sliced" view, and `analyzeVergence`
//     (template-match each fovea into the wide strip).
// It posts SCALAR results (match rects/scores, tracker bbox) + derived display
// frames; MAIN keeps calibration + `stepVergence`/PID → voltages (session.ts).

import { copyMat, makeMat } from "@lib/mat";
import { RECT } from "@lib/util/geometry";
import type { Point2d, Rect, Size } from "core/Geometry";
import { cvtColor, diff, slice, wrapPerspective, type Mat } from "core/Vision";
import { KCF } from "core/Tracker";
import {
  analyzeVergence,
  getFoveaTile,
  foveaTileSize,
  matchMagnification,
  type MatchResult,
} from "./vergence";
import type {
  FrameSet,
  KernelFrameOut,
  KernelOutput,
  VisionKernel,
} from "@orchestrator/vision-kernel";

/** Params main pushes to the kernel (init + live updates, merged). Homographies
 *  are the flat 9-element row-major matrices `conv.A2H[role](V2A[role](volts))`,
 *  recomputed by main on each throttled volt update. */
export type DisparityParams = {
  /** 9-element row-major homography for each fovea's current pose (or null). */
  homographyL?: number[] | null;
  homographyR?: number[] | null;
  kernelW?: number;
  kernelH?: number;
  /** Nominal UI zoom — drives ONLY the sliced-view crop size. */
  zoom?: number;
  /** Calibration-MEASURED fovea↔wide magnification (main derives it from the
   *  triple via `foveaWideMagnification`) — drives the tile/strip match scale.
   *  Null/absent (uncalibrated/legacy rigs) falls back to `zoom`, the exact
   *  pre-measurement behavior (`matchMagnification`). */
  matchZoom?: number | null;
  /** Effective fovea-tile scale (main folds the match zoom + tuning.scale). */
  scale?: number;
  target?: Point2d;
  expand_x?: number;
  expand_y?: number;
  view?: string;
  wrap?: boolean;
  lostTolerance?: number;
  /** Main requests a (re)init at this center on the next center tick. */
  trackerInit?: Point2d | null;
  /** Main requests release of the auto-follow tracker. */
  trackerRelease?: boolean;
};

/** Scalar match result over the wire (the heatmap `mat` goes as a frame). */
export type WireMatch = { rect: Rect; score: number };

/** Worker→main scalar results for one vergence tick. */
export type DisparityValues = {
  analysis?: {
    ml: WireMatch;
    mr: WireMatch;
    center: { rect: Rect };
    ox: number;
    oy: number;
  };
  tracker?:
    | { status: "tracking"; center: Point2d; bbox: Rect }
    | { status: "lost" };
  size?: Size;
};

const wire = (m: MatchResult): WireMatch => ({ rect: m.rect, score: m.score });

function toHomography(nums: number[] | null | undefined): Mat<Float64Array> | null {
  if (!nums || nums.length < 9) return null;
  return makeMat(new Float64Array(nums.slice(0, 9)), [3, 3], 1);
}

export function createDisparityKernel(initial: Record<string, unknown>): VisionKernel {
  const p: Required<
    Omit<
      DisparityParams,
      "homographyL" | "homographyR" | "trackerInit" | "trackerRelease" | "matchZoom"
    >
  > & {
    homographyL: Mat<Float64Array> | null;
    homographyR: Mat<Float64Array> | null;
    matchZoom: number | null;
  } = {
    homographyL: null,
    homographyR: null,
    kernelW: 64,
    kernelH: 64,
    zoom: 1,
    matchZoom: null,
    scale: 1,
    target: { x: 0, y: 0 },
    expand_x: 3,
    expand_y: 2,
    view: "sliced",
    wrap: false,
    lostTolerance: 10,
  };

  let width = 0;
  let height = 0;
  let tileL: Mat<Uint8Array> | null = null;
  let tileR: Mat<Uint8Array> | null = null;
  const aligned: { L: Mat<Uint8Array> | null; R: Mat<Uint8Array> | null } = {
    L: null,
    R: null,
  };

  // Synchronous KCF auto-follow (no async-kcf — single-threaded loop).
  let kcf: KCF | null = null;
  let search: Rect | null = null;
  let lostCount = 0;
  let pendingInit: Point2d | null = null;

  function clampRect(r: Rect): Rect {
    const x = Math.max(0, Math.min(r.x, width));
    const y = Math.max(0, Math.min(r.y, height));
    return {
      x,
      y,
      width: Math.max(0, Math.min(r.width, width - x)),
      height: Math.max(0, Math.min(r.height, height - y)),
    };
  }

  function searchWindow(box: Rect, scale = 1): Rect {
    const px = Math.max(0, p.kernelW * scale);
    const py = Math.max(0, p.kernelH * scale);
    const x = Math.max(0, Math.round(box.x - px));
    const y = Math.max(0, Math.round(box.y - py));
    const right = Math.min(width, Math.round(box.x + box.width + px));
    const bottom = Math.min(height, Math.round(box.y + box.height + py));
    return clampRect({ x, y, width: right - x, height: bottom - y });
  }

  function releaseTracker(): void {
    kcf?.release();
    kcf = null;
    search = null;
    lostCount = 0;
  }

  function initTracker(view: Mat<Uint8Array>, center: Point2d): DisparityValues["tracker"] {
    const roi = clampRect(RECT.fromCenter(center, { width: p.kernelW, height: p.kernelH }));
    if (roi.width <= 0 || roi.height <= 0) return undefined;
    releaseTracker();
    const win = searchWindow(roi);
    const patch = cvtColor(slice(view, win), "BGRA2BGR");
    const t = new KCF();
    t.init(patch, { x: roi.x - win.x, y: roi.y - win.y, width: roi.width, height: roi.height });
    kcf = t;
    search = roi;
    lostCount = 0;
    p.target = center;
    return { status: "tracking", center, bbox: roi };
  }

  function updateTracker(view: Mat<Uint8Array>): DisparityValues["tracker"] {
    if (!kcf || !search) return undefined;
    const win = searchWindow(search, 1 + lostCount);
    const patch = cvtColor(slice(view, win), "BGRA2BGR");
    const r = kcf.update(patch); // synchronous — worker thread
    if (r) {
      lostCount = 0;
      const full = clampRect({ x: r.x + win.x, y: r.y + win.y, width: r.width, height: r.height });
      search = full;
      const center = RECT.getCenter(full);
      p.target = center;
      return { status: "tracking", center, bbox: full };
    }
    if (++lostCount >= p.lostTolerance) {
      releaseTracker();
      return { status: "lost" };
    }
    return undefined; // dropped: sub-threshold miss, no observable change
  }

  /** Magnification for the fovea↔wide match: measured, else nominal zoom. */
  function matchZoom(): number {
    return matchMagnification(p.matchZoom, p.zoom);
  }

  function tileSize(): Size {
    return foveaTileSize({ width, height, zoom: matchZoom(), scale: p.scale });
  }

  async function processFovea(
    role: "L" | "R",
    raw: Mat<Uint8Array>,
    out: KernelFrameOut[],
  ): Promise<void> {
    const H = role === "L" ? p.homographyL : p.homographyR;
    // `wrapPerspective` allocates a fresh Mat; without a homography yet, copy —
    // `raw` is the worker's reused read buffer, overwritten next tick, but
    // `aligned[role]` is retained across ticks for the "disparity" diff.
    const wrapped = H ? wrapPerspective(raw, H) : copyMat(raw);
    out.push({ name: role, mat: p.wrap && H ? wrapped : raw });
    aligned[role] = wrapped;
    if (width && height) {
      const tile = await getFoveaTile(wrapped, tileSize());
      if (role === "L") tileL = tile;
      else tileR = tile;
    }
    if (role === "R" && p.view === "disparity" && aligned.L && aligned.R) {
      out.push({ name: "center.disparity", mat: diff(aligned.L, aligned.R, true) });
    }
  }

  async function processCenter(
    c: Mat<Uint8Array>,
    seq: number,
    out: KernelFrameOut[],
    values: DisparityValues,
  ): Promise<void> {
    const [h, w] = c.shape;
    if (w !== width || h !== height) {
      width = w;
      height = h;
      values.size = { width, height };
    }
    if (pendingInit) {
      const center = pendingInit;
      pendingInit = null;
      values.tracker = initTracker(c, center);
    } else if (kcf) {
      const r = updateTracker(c);
      if (r) values.tracker = r;
    }
    out.push({ name: "C", mat: c });
    if (p.view === "sliced" && width && height) {
      const zoom = Math.max(1, p.zoom);
      const rect = clampRect(
        RECT.fromCenter(p.target, { width: width / zoom, height: height / zoom }),
      );
      out.push({ name: "center.sliced", mat: slice(c, rect) });
    }
    if (tileL && tileR) {
      const analysis = await analyzeVergence({ l: tileL, r: tileR }, c, {
        width,
        height,
        zoom: matchZoom(), // measured magnification (nominal-zoom fallback)
        scale: p.scale,
        target: p.target,
        expand_x: p.expand_x,
        expand_y: p.expand_y,
      });
      out.push({ name: "guide", mat: analysis.guide });
      out.push({ name: "match_left", mat: analysis.ml.mat });
      out.push({ name: "match_right", mat: analysis.mr.mat });
      values.analysis = {
        ml: wire(analysis.ml),
        mr: wire(analysis.mr),
        center: analysis.center,
        ox: analysis.ox,
        oy: analysis.oy,
      };
    }
    void seq;
  }

  const kernel: VisionKernel = {
    setParams(params: Record<string, unknown>): void {
      const d = params as DisparityParams;
      if ("homographyL" in d) p.homographyL = toHomography(d.homographyL);
      if ("homographyR" in d) p.homographyR = toHomography(d.homographyR);
      if (d.kernelW !== undefined) p.kernelW = d.kernelW;
      if (d.kernelH !== undefined) p.kernelH = d.kernelH;
      if (d.zoom !== undefined) p.zoom = d.zoom;
      if (d.matchZoom !== undefined) p.matchZoom = d.matchZoom;
      if (d.scale !== undefined) p.scale = d.scale;
      if (d.target !== undefined) p.target = d.target;
      if (d.expand_x !== undefined) p.expand_x = d.expand_x;
      if (d.expand_y !== undefined) p.expand_y = d.expand_y;
      if (d.view !== undefined) p.view = d.view;
      if (d.wrap !== undefined) p.wrap = d.wrap;
      if (d.lostTolerance !== undefined) p.lostTolerance = d.lostTolerance;
      if (d.trackerRelease) releaseTracker();
      if ("trackerInit" in d) pendingInit = d.trackerInit ?? null;
    },

    async process(frames: FrameSet): Promise<KernelOutput> {
      const out: KernelFrameOut[] = [];
      const values: DisparityValues = {};
      if (frames.L) await processFovea("L", frames.L.mat, out);
      if (frames.R) await processFovea("R", frames.R.mat, out);
      let driveSeq: number | undefined;
      let driveTs: number | undefined;
      if (frames.C) {
        driveSeq = frames.C.seq;
        driveTs = frames.C.deviceTimestamp;
        await processCenter(frames.C.mat, frames.C.seq, out, values);
      }
      if (out.length === 0 && Object.keys(values).length === 0) return null;
      return { values: { ...values, seq: driveSeq, deviceTimestamp: driveTs }, frames: out };
    },

    dispose(): void {
      releaseTracker();
    },
  };

  kernel.setParams(initial); // apply the worker's init params (same merge path)
  return kernel;
}
