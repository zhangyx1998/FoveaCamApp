// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Compression brick seam: a core-free wrapper over Aravis.attachCompressPipe. The
// native thread FIFO-reads an already-advertised source pipe and republishes each
// frame as an INDEPENDENT per-frame zlib blob (keeps the container seekable) into a
// sibling output pipe whose advert bakes the `/zlib` suffix into pixelFormat (ruling
// 9); the recorder consumes it verbatim (ruling 8). Consumer-gated; never imports core.
// spec: docs/spec/pipes.md#compress-pipe

import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";
import type { RawPipeAdvertSpec } from "./raw-pipe.js";

export interface CompressPipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  /** `Aravis.attachCompressPipe(sourcePipeId, pipeId, options)`. */
  attach(sourcePipeId: string, pipeId: string, options?: { level?: number }): void;
  /** `Aravis.detachCompressPipe(pipeId)` (joins the runner). */
  detach(pipeId: string): void;
}

export interface CompressHandle {
  readonly pipeId: string;
  /** The output advert (+ the JS-side significantBits carried over from the
   *  source — the recorder connect seam injects it verbatim, ruling 8). */
  readonly spec: RawPipeAdvertSpec;
  /** Detach the brick + un-advertise the output (consumers see CLOSED). */
  retire(): void;
}

/** zlib worst-case output bound for an `n`-byte input (`compressBound`):
 *  n + ceil(n/16k)*5-ish + header — the canonical n + (n>>12) + (n>>14) +
 *  (n>>25) + 13 formula, matching what the native brick sizes its slots to. */
export const zlibBound = (n: number): number =>
  n + (n >> 12) + (n >> 14) + (n >> 25) + 13;

/** Codec suffix appended to the source `pixelFormat` (ruling 9). */
export const ZLIB_SUFFIX = "/zlib";

/** Build the sibling output advert for a compressed stream: source format +
 *  `/zlib`, same dims/significantBits, worst-case slot. The payload is an
 *  opaque VARIABLE-LENGTH byte blob (ring v5 `payloadBytes` carries the exact
 *  compressed length; `bytesPerFrame` stays the source's nominal size). */
export function compressPipeSpec(
  source: RawPipeAdvertSpec,
  pipeId = `${source.id}${ZLIB_SUFFIX}`,
): RawPipeAdvertSpec {
  const srcMax = Math.max(source.maxBytes ?? 0, source.bytesPerFrame);
  const bound = zlibBound(srcMax);
  return {
    ...source,
    id: pipeId,
    pixelFormat: `${source.pixelFormat}${ZLIB_SUFFIX}`,
    dtype: "U8",
    // The brick forwards the SOURCE frame's identity (width/height/origin) per
    // blob, so the output ring must admit the source's max ACTIVE dims
    // (`offer()` guards width>maxWidth / height>maxHeight — core test 32); only
    // the SLOT byte size grows to the zlib worst case. The actual per-frame
    // blob length rides the ring-v5 slot header, never dim-derived.
    maxWidth: source.maxWidth ?? source.stride,
    maxHeight: source.maxHeight ?? source.height,
    maxBytes: bound,
  };
}

/** Advertise the `/zlib` sibling + attach the native compression brick chained
 *  on `source.id`. Advertise BEFORE attach (the producer looks its pipe up). */
export function createCompressPipe(
  seam: CompressPipeSeam,
  source: RawPipeAdvertSpec,
  options?: { level?: number },
): CompressHandle {
  const spec = compressPipeSpec(source);
  seam.advertise(spec);
  seam.attach(source.id, spec.id, options);
  return {
    pipeId: spec.id,
    spec,
    retire: () => {
      seam.detach(spec.id);
      seam.unadvertise(spec.id);
    },
  };
}
