// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// GENERAL-PURPOSE session-owned COMPOSITE node (composite-node-and-center-
// select-fix §B, ruled 2026-07-09): a two-input native brick
// (`CompositeStream`) — a per-pixel BGRA op (anaglyph / L-vs-R difference)
// over a left/right pair of frame pipes, publishing a RGBA8 pipe.
//
// Ticks on every LEFT arrival paired with the LATEST RIGHT frame (latest-wins
// on both taps — no cross-camera seq comparison); the output is in LEFT-frame
// coordinates and the left frame's timestamps/origin are forwarded. The mode
// is REACTIVE (`retune`, applied on the next tick, no re-attach).
//
// ON-DEMAND (ruling 2) is the ChainedStream contract: the brick runs iff its
// pipe has consumers; parked, its cost is exactly zero — selecting the center
// view IS the demand.
//
// Seam-injected (never imports native core) — index.ts wires
// `Aravis.attachCompositePipe`/`setCompositeParams`/`detachCompositePipe`.

import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";
import type { AnaglyphStyle } from "../../docs/schema/anaglyph.js";

/** Reactive composite params — `mode` = `anaglyph` (left/right split by color)
 *  or `difference` (|L − R| per color channel); `style` = the anaglyph left/
 *  right color arrangement (default `RC` = red-left/cyan-right; ignored by
 *  `difference`). Both are applied on the next tick with no re-attach. */
export type CompositeParams = {
  mode?: "anaglyph" | "difference";
  style?: AnaglyphStyle;
};

export interface CompositePipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  attach(
    leftPipeId: string,
    rightPipeId: string,
    pipeId: string,
    params: CompositeParams,
  ): void;
  retune(pipeId: string, params: CompositeParams): void;
  detach(pipeId: string): void;
}

export interface CompositePipeOptions {
  params?: CompositeParams;
  /** Ring footprint = the LEFT source's max dims (output is left-sized). */
  maxWidth: number;
  maxHeight: number;
}

export interface CompositeHandle {
  readonly pipeId: string;
  /** Reactively retune the composite mode (applied on the next tick). */
  retune(params: CompositeParams): void;
  /** Detach the producer + un-advertise (consumers see CLOSED). */
  retire(): void;
}

/** Advertise the RGBA8 composite pipe + attach the composite brick chained on
 *  the two source pipes. Advertise BEFORE attach. */
export function createCompositePipe(
  seam: CompositePipeSeam,
  leftPipeId: string,
  rightPipeId: string,
  pipeId: string,
  opts: CompositePipeOptions,
): CompositeHandle {
  const { maxWidth, maxHeight } = opts;
  const channels = 4;
  seam.advertise({
    id: pipeId,
    pixelFormat: "RGBA8",
    dtype: "U8",
    width: maxWidth,
    height: maxHeight,
    channels,
    stride: maxWidth * channels,
    bytesPerFrame: maxWidth * maxHeight * channels,
    ringDepth: 4,
    maxWidth,
    maxHeight,
    maxBytes: maxWidth * maxHeight * channels,
  });
  seam.attach(leftPipeId, rightPipeId, pipeId, opts.params ?? {});
  return {
    pipeId,
    retune: (p) => seam.retune(pipeId, p),
    retire: () => {
      seam.detach(pipeId);
      seam.unadvertise(pipeId);
    },
  };
}
