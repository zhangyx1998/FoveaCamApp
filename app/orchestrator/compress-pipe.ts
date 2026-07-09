// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// COMPRESSION brick seam (multi-fovea-recording rulings 9/10, wave I-2). A
// core-free wrapper over `Aravis.attachCompressPipe`: the native thread
// FIFO-reads an ALREADY-ADVERTISED source pipe (raw12p / raw / convert / …)
// and republishes each frame as an INDEPENDENT zlib blob (per-frame, so the
// container stays seekable) into a sibling output pipe advertised here.
//
// The output advert carries the source format with the `/zlib` suffix baked
// into `pixelFormat` (ruling 9 — offline readers split on "/" and decompress
// right-to-left), the SAME dims/significantBits as the source, and `maxBytes`
// sized to the zlib worst case. The recorder consumes the output pipe with
// ZERO extra config (advert-verbatim socket, ruling 8).
//
// Consumer-gated like every pipe: the output pipe's 0→1 connect edge spins the
// native runner up (connects the source); →0 parks it. Seam-injected so the
// session and vitest run without the addon.

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
