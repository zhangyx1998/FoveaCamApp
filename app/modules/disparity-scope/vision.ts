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
//   - per fovea: the fovea arrives PRE-WARPED off its own `camera/<serial>/
//     undistort` (homography) pipe — the kernel no longer does `wrapPerspective`
//     and needs no homography params — so it just retains the aligned frame
//     (for the "disparity" diff) and cuts a grayscale downsampled match tile
//     (`getFoveaTile`);
//   - center: the wide input is now the center camera's `undistort` pipe, so
//     `analyzeVergence`'s template match + the projected positions live on the
//     UNDISTORTED view (P2A on it is linear). It cuts the "sliced" view and
//     matches each fovea into the wide strip.
// The KCF auto-follow is GONE from this kernel (controller-node-and-fifo-edges
// §3.5 — "the tracker must leave the disparity-matching thread"): the tracker
// runs on its OWN native thread (`createChainedTracker` on the C undistort
// brick, owned by the SESSION), and its scalar output arrives here as the
// `target` param + the `overridden` drag flag at result rate — tracking
// latency no longer rides the matching budget.
// It posts SCALAR results (match rects/scores) + the scope `projection`
// (matched centres + target, wide pixels, `overridden` carried through) +
// derived DIAGNOSTIC frames (`center.sliced`/`center.disparity`/`guide`/
// `match_*`); MAIN keeps calibration + the PID node's `stepVergence` →
// voltages (session.ts). The kernel no longer emits L/C/R view frames — the
// views source directly from the undistort pipes so a busy kernel can't cap
// their fps.

import { copyMat } from "@lib/mat";
import { RECT } from "@lib/util/geometry";
import type { Point2d, Rect, Size } from "core/Geometry";
import { diff, slice, type Mat } from "core/Vision";
import {
  analyzeVergence,
  getFoveaTile,
  foveaTileSize,
  matchMagnification,
  scopeProjection,
  type MatchResult,
  type ScopeProjection,
} from "./vergence";
import type {
  FrameSet,
  KernelFrameOut,
  KernelOutput,
  VisionKernel,
} from "@orchestrator/vision-kernel";

/** Params main pushes to the kernel (init + live updates, merged). Post-replumb
 *  there are NO homographies (the foveas arrive pre-warped off their undistort
 *  pipes) and NO tracker knobs (§3.5 — the session owns the chained tracker
 *  and pushes its scalar output here as `target` + `overridden`). */
export type DisparityParams = {
  /** Nominal UI zoom — drives the sliced-view crop AND the guide strip crop
   *  (the center tile expanded by expand_x/expand_y). NOT the match scale. */
  zoom?: number;
  /** Calibration-MEASURED fovea↔wide magnification (main derives it from the
   *  triple via `foveaWideMagnification`) — drives the tile/strip match scale.
   *  Null/absent (uncalibrated/legacy rigs) falls back to `zoom`, the exact
   *  pre-measurement behavior (`matchMagnification`). */
  matchZoom?: number | null;
  /** Effective fovea-tile scale (main folds the match zoom + tuning.scale). */
  scale?: number;
  /** Target center on the undistorted wide frame — the chained tracker's
   *  output (or the pointer, while dragging), pushed by main at result rate. */
  target?: Point2d;
  /** True while `target` rides the TRACKER OVERRIDE (pointer drag) — carried
   *  through onto `projection.overridden` so downstream stages (PID vergence)
   *  can act correspondingly. */
  overridden?: boolean;
  expand_x?: number;
  expand_y?: number;
  view?: string;
};

/** Scalar match result over the wire (the heatmap `mat` goes as a frame). */
export type WireMatch = { rect: Rect; score: number };

/** Worker→main scalar results for one vergence tick. */
export type DisparityValues = {
  /** Strip-local match rects + scores — DIAGNOSTIC only (drives the guide-strip
   *  overlays); the control path reads {@link ScopeProjection} instead. */
  analysis?: {
    ml: WireMatch;
    mr: WireMatch;
    center: { rect: Rect };
    ox: number;
    oy: number;
  };
  /** The scope's control OUTPUT — matched fovea centres + target on the
   *  undistorted wide frame (full-res wide pixels) + per-eye scores + the
   *  `overridden` drag flag. Consumed by the PID node's `stepVergence`;
   *  emitted whenever `analysis` is. */
  projection?: ScopeProjection;
  size?: Size;
};

const wire = (m: MatchResult): WireMatch => ({ rect: m.rect, score: m.score });

export function createDisparityKernel(initial: Record<string, unknown>): VisionKernel {
  const p: Required<Omit<DisparityParams, "matchZoom">> & {
    matchZoom: number | null;
  } = {
    zoom: 1,
    matchZoom: null,
    scale: 1,
    target: { x: 0, y: 0 },
    overridden: false,
    expand_x: 3,
    expand_y: 2,
    view: "sliced",
  };

  let width = 0;
  let height = 0;
  let tileL: Mat<Uint8Array> | null = null;
  let tileR: Mat<Uint8Array> | null = null;
  const aligned: { L: Mat<Uint8Array> | null; R: Mat<Uint8Array> | null } = {
    L: null,
    R: null,
  };

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

  /** Magnification for the fovea↔wide match: measured, else nominal zoom. */
  function matchZoom(): number {
    return matchMagnification(p.matchZoom, p.zoom);
  }

  function tileSize(): Size {
    return foveaTileSize({ width, height, zoom: matchZoom(), scale: p.scale });
  }

  async function processFovea(
    role: "L" | "R",
    frame: Mat<Uint8Array>,
    out: KernelFrameOut[],
  ): Promise<void> {
    // The fovea arrives PRE-WARPED off `camera/<serial>/undistort` (homography
    // variant) — the kernel no longer warps. `frame` is the worker's reused
    // read buffer (overwritten next tick), but `aligned[role]` is retained
    // across ticks for the "disparity" diff, so retain a copy. No L/R view
    // frame is emitted (the views source directly from the undistort pipes).
    const a = copyMat(frame);
    aligned[role] = a;
    if (width && height) {
      const tile = await getFoveaTile(a, tileSize());
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
    // No KCF here (§3.5): `p.target`/`p.overridden` arrive from the session's
    // chained tracker thread via setParams.
    // No "C" view frame — the center view sources directly from the undistort
    // pipe. `c` is the UNDISTORTED wide frame (the kernel's C input is now the
    // center camera's undistort pipe), so the sliced crop + the match + the
    // projection all live in undistorted wide pixels.
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
        // NOMINAL crop zoom (same as the sliced-view crop above) → the guide
        // strip is the center tile expanded by expand_x/expand_y, and its
        // center marker == the sliced center tile. The fovea TILES were already
        // sized to the match magnification (`tileSize`), so the match scale is
        // unaffected by this crop-size choice.
        zoom: Math.max(1, p.zoom),
        scale: p.scale,
        target: p.target,
        expand_x: p.expand_x,
        expand_y: p.expand_y,
      });
      out.push({ name: "guide", mat: analysis.guide });
      out.push({ name: "match_left", mat: analysis.ml.mat });
      out.push({ name: "match_right", mat: analysis.mr.mat });
      const wireAnalysis = {
        ml: wire(analysis.ml),
        mr: wire(analysis.mr),
        center: analysis.center,
        ox: analysis.ox,
        oy: analysis.oy,
      };
      values.analysis = wireAnalysis;
      // The control OUTPUT: matched centres + target lifted to full-res wide
      // pixels (strip offsets folded in), the tracker-override flag carried
      // through — the only thing the PID node reads.
      values.projection = scopeProjection(wireAnalysis, p.overridden);
    }
    void seq;
  }

  const kernel: VisionKernel = {
    setParams(params: Record<string, unknown>): void {
      const d = params as DisparityParams;
      if (d.zoom !== undefined) p.zoom = d.zoom;
      if (d.matchZoom !== undefined) p.matchZoom = d.matchZoom;
      if (d.scale !== undefined) p.scale = d.scale;
      if (d.target !== undefined) p.target = d.target;
      if (d.overridden !== undefined) p.overridden = d.overridden;
      if (d.expand_x !== undefined) p.expand_x = d.expand_x;
      if (d.expand_y !== undefined) p.expand_y = d.expand_y;
      if (d.view !== undefined) p.view = d.view;
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
      // Nothing owned: the tracker lives on its own native thread (session-
      // owned); tiles/aligned Mats are GC-managed.
    },
  };

  kernel.setParams(initial); // apply the worker's init params (same merge path)
  return kernel;
}
