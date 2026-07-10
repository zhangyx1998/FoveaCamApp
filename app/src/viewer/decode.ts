// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `x-fovea-raw` → displayable Mat, driven entirely by the §2b channel
// metadata (dtype / shape / channels / pixelFormat / significantBits) —
// never by sniffing bytes. Mirrors what the live paths do: 16-bit data is
// scaled to 8-bit by its significant bit depth (12p data lives 0..4095 in a
// 16-bit container — see the `significantBits` schema + the 12-bit readout
// project), Bayer mosaics are demosaiced to RGB via core Vision's
// `cvtColor`, and the result is a 1/3/4-channel Uint8Array Mat, exactly what
// `FrameView`'s ImageData path renders.
//
// core Vision is imported lazily and only when a channel actually needs it
// (U16 scaling / Bayer demosaic) — pure-U8 channels (Mono8/BGRA8 previews)
// decode with zero native involvement. The factory is async for that reason;
// the returned decoder is synchronous per frame (the player meters it).
//
// Runs on the viewer window's WORKER THREAD (standalone-viewer-and-fcap
// ruling 1) — the explicit, scoped exception to the no-core-in-renderer rule:
// the viewer is an offline utility over files, decoupled from the
// orchestrator, and decode stays off the window's UI thread.

import { inflateSync } from "node:zlib";
import type { Mat } from "core/Vision";
import { type Dtype } from "@lib/util/dtype";
import { pixelFormatSpec, cvBayerPrefix } from "../../../docs/schema/pixel-formats.js";

export type FrameDecoder = (bytes: Uint8Array) => Mat<Uint8Array>;

/** Per-frame decompressors keyed by the `/codec` suffix (multi-fovea-recording
 *  ruling 9). Only codecs the platform provides without new deps — zlib today
 *  (bz2 pluggable when core adds it). Each blob is INDEPENDENTLY compressed, so
 *  a single frame decompresses alone (the container stays seekable). */
const CODECS: Record<string, (bytes: Uint8Array) => Uint8Array> = {
  zlib: (bytes) => new Uint8Array(inflateSync(bytes)),
};

/** Split a `pixelFormat` string on `/`: the base format + its codec suffix
 *  chain (in APPLY order — leftmost applied first). Offline readers decompress
 *  right-to-left, then interpret the base format (ruling 9). */
export function splitCodecs(pixelFormat: string): { base: string; codecs: string[] } {
  const parts = pixelFormat.split("/");
  return { base: parts[0] ?? "", codecs: parts.slice(1) };
}

/** Undo the codec chain right-to-left (the rightmost suffix was applied last).
 *  Throws for an unknown codec — the player skips + accounts that channel. */
export function decompressChain(bytes: Uint8Array, codecs: string[]): Uint8Array {
  let out = bytes;
  for (let i = codecs.length - 1; i >= 0; i--) {
    const fn = CODECS[codecs[i]!];
    if (!fn) throw new Error(`unsupported frame codec "${codecs[i]}"`);
    out = fn(out);
  }
  return out;
}

/** Unpack a GenICam 12p byte stream (2 samples in 3 bytes) into 16-bit samples
 *  (0..4095). Byte layout per pair: b0 = s0[7:0]; b1 = (s1[3:0]<<4)|s0[11:8];
 *  b2 = s1[11:4]. A trailing odd sample (rare — even sensor widths) reads 1.5
 *  bytes. Display-quality unpack for PLAYBACK (offline analysis reads the packed
 *  bytes directly per the MCAP schema). */
export function unpack12p(bytes: Uint8Array, samples: number): Uint16Array {
  const out = new Uint16Array(samples);
  let bi = 0;
  let oi = 0;
  while (oi + 1 < samples) {
    const b0 = bytes[bi] ?? 0;
    const b1 = bytes[bi + 1] ?? 0;
    const b2 = bytes[bi + 2] ?? 0;
    out[oi++] = b0 | ((b1 & 0x0f) << 8);
    out[oi++] = (b1 >> 4) | (b2 << 4);
    bi += 3;
  }
  if (oi < samples) {
    const b0 = bytes[bi] ?? 0;
    const b1 = bytes[bi + 1] ?? 0;
    out[oi] = b0 | ((b1 & 0x0f) << 8);
  }
  return out;
}

/** The §2b static decode props, parsed out of `FoveaChannel.metadata`. */
export interface DecodeProps {
  dtype: Dtype;
  shape: number[];
  channels: number;
  pixelFormat: string;
  significantBits: number;
  /** Advertised bytes-per-row on the wire (verbatim from the pipe advert). May
   *  exceed the tight row (width·channels·bytesPerElement, or the packed row for
   *  a 12p wire) when the transport carries row padding — the decoder strips it
   *  before interpreting (F3 striped-decode). `undefined`/0 ⇒ rows are tight. */
  stride?: number;
}

export function parseDecodeProps(metadata: Record<string, string>): DecodeProps {
  const dtype = metadata.dtype as Dtype;
  const shape = JSON.parse(metadata.shape ?? "[]") as number[];
  if (!dtype || !Array.isArray(shape) || shape.length < 2)
    throw new Error("channel metadata is missing x-fovea-raw decode props");
  const strideRaw = Number(metadata.stride);
  const props = {
    dtype,
    shape,
    channels: Number(metadata.channels ?? "1"),
    pixelFormat: metadata.pixelFormat ?? "Mono8",
    significantBits: Number(metadata.significantBits ?? "8"),
    stride: Number.isFinite(strideRaw) && strideRaw > 0 ? strideRaw : undefined,
  };
  warnOnSchemaDrift(props);
  return props;
}

/** GenICam 12p packs 12 bits per sample (2 samples in 3 bytes) — every packed
 *  format in the registry is a `*12p`. The tight (unpadded) packed row for
 *  `samples` pixels is `ceil(samples · 12 / 8)` bytes. */
const PACKED_BITS_PER_SAMPLE = 12;

/** Strip row padding: if the wire `stride` exceeds the tight row byte count,
 *  copy each row's leading `tightRow` bytes into a contiguous buffer so the
 *  downstream interpretation (unpack12p / Uint8/16 reshape) sees tight rows.
 *  A no-op when `stride` is absent, equal to (or smaller than — a broken advert
 *  we don't trust) the tight row, or the payload is too short (F3). */
function stripRowPadding(
  bytes: Uint8Array,
  stride: number | undefined,
  tightRow: number,
  rows: number,
): Uint8Array {
  if (!stride || stride <= tightRow || rows <= 0) return bytes;
  if (bytes.byteLength < stride * (rows - 1) + tightRow) return bytes;
  const out = new Uint8Array(tightRow * rows);
  for (let r = 0; r < rows; r++)
    out.set(bytes.subarray(r * stride, r * stride + tightRow), r * tightRow);
  return out;
}

function warnOnSchemaDrift(props: DecodeProps): void {
  const { base } = splitCodecs(props.pixelFormat);
  const spec = pixelFormatSpec(base);
  if (!spec) return;
  // A packed (12p) or codec-suffixed channel is an opaque byte stream on the
  // wire — the container dtype is "U8" (packed verbatim / codec blob). A packed
  // sensor format ALSO legitimately names the UNPACKED 16-bit container (the
  // `raw` tap expands 12p at Frame construction → dtype = the format's own
  // unpacked dtype, U16). Both are truthful transport dtypes for a packed base;
  // only a value that is neither is real drift.
  const transportPacked = spec.isPacked || base !== props.pixelFormat;
  const allowedDtypes = transportPacked ? ["U8", spec.dtype] : [spec.dtype];
  const mismatches = [
    ["dtype", props.dtype, allowedDtypes.join(" | "), allowedDtypes.includes(props.dtype)],
    ["channels", props.channels, spec.channels, props.channels === spec.channels],
    ["significantBits", props.significantBits, spec.significantBits, props.significantBits === spec.significantBits],
  ].filter(([, , , ok]) => !ok);
  if (mismatches.length === 0) return;
  console.warn("[viewer] recording metadata differs from pixel-format schema", {
    pixelFormat: props.pixelFormat,
    mismatches: Object.fromEntries(
      mismatches.map(([field, recorded, expected]) => [
        field,
        { recorded, expected },
      ]),
    ),
  });
}

type BayerCode = `Bayer${"GR" | "RG" | "GB" | "BG"}2RGB`;

/** OpenCV demosaic code for a pixel format, or null if it's not Bayer — driven
 *  by the shared registry (docs/schema, B-P1), NOT a private regex, so viewer
 *  demosaic can't drift from the format facts. The cv constant carries the
 *  OpenCV↔PFNC off-by-one R/B-swap correction (`cvBayerPrefix`,
 *  channel-order-fix.md): a GenICam BayerRG mosaic demosaics with
 *  `COLOR_BayerBG2RGB`, so an old raw-Bayer recording renders red-as-red.
 *  Output is honest RGB (FrameView pours R,G,B into an RGBA-native canvas).
 *  Exported for the C-P6 conformance test. */
export const bayerCode = (pixelFormat: string): BayerCode | null => {
  const bayer = pixelFormatSpec(pixelFormat)?.bayer;
  return bayer ? (`${cvBayerPrefix(bayer)}2RGB` as BayerCode) : null;
};

function frameBuffer(bytes: Uint8Array, dtype: Dtype): ArrayBuffer {
  const needsAligned16 = dtype === "U16";
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    (!needsAligned16 || bytes.byteOffset % 2 === 0)
  )
    return bytes.buffer as ArrayBuffer;
  // The decoded Mat can outlive this call, so a reusable scratch buffer would
  // make later frames mutate earlier ones. Copy only when alignment/slicing
  // forces it.
  return bytes.slice().buffer;
}

/**
 * Build the synchronous per-frame decoder for one channel. Throws for dtypes
 * the preview path doesn't support (the recorder writes U8/U16 camera Mats —
 * anything else in a container is foreign data; the player skips that
 * channel and accounts it, it never kills playback).
 */
export async function createFrameDecoder(
  metadata: Record<string, string>,
): Promise<FrameDecoder> {
  const props = parseDecodeProps(metadata);
  const { dtype, shape, channels, pixelFormat, significantBits, stride } = props;
  // The transport pixelFormat may carry `/codec` suffixes over a base format
  // that may itself be PACKED (12p). Peel the codec chain per frame; unpack a
  // packed base to a 16-bit container for display.
  const { base, codecs } = splitCodecs(pixelFormat);
  // A 12p sensor format names TWO distinct transports (raw-pipe.ts): the packed
  // verbatim wire (`raw12p` tap → dtype U8, 1.5 B/px) and the UNPACKED 16-bit
  // container (`raw` tap → dtype U16, 2 B/px — `Arv::Frame` already expanded
  // the 12p at construction). Both advertise the SAME packed pixelFormat name
  // (`isPacked` true), so `isPacked` alone can't tell them apart — the advert's
  // DTYPE is the transport-packing truth: U8 ⇒ packed wire (unpack), U16 ⇒
  // already-unpacked container (reshape). Trusting `isPacked` blindly is the F3
  // striped-decode bug: it ran unpack12p over an already-16-bit raw-pipe frame.
  const formatPacked = pixelFormatSpec(base)?.isPacked ?? false;
  const packed = formatPacked && dtype === "U8";
  if (!packed && dtype !== "U8" && dtype !== "U16")
    throw new Error(`unsupported preview dtype "${dtype}"`);
  // Row geometry for stride-aware unpadding: shape is [H, W] or [H, W, C].
  const rows = shape[0] ?? 0;
  const rowWidth = shape[1] ?? 0;

  const bayer = bayerCode(base);
  const scale8 = 255 / ((1 << significantBits) - 1);
  const needsVision = packed || dtype === "U16" || bayer !== null;
  const vision = needsVision ? await import("core/Vision") : null;

  return (wire: Uint8Array): Mat<Uint8Array> => {
    // Right-to-left decode: decompress the codec chain, then interpret the base.
    const decompressed = codecs.length > 0 ? decompressChain(wire, codecs) : wire;
    let mat: Mat<Uint8Array>;
    if (packed) {
      // 12p wire → 16-bit samples (owns a fresh buffer, no aliasing), then the
      // same significantBits down-scale the live 12-bit path uses (→ /4095).
      // Strip any row padding FIRST (stride ≠ tight packed row) so a padded
      // payload unpacks row-aligned instead of shearing (F3).
      const tightRow = Math.ceil((rowWidth * channels * PACKED_BITS_PER_SAMPLE) / 8);
      const bytes = stripRowPadding(decompressed, stride, tightRow, rows);
      const samples = shape.reduce((a, b) => a * b, 1);
      const raw = Object.assign(unpack12p(bytes, samples), {
        shape: [...shape],
        channels,
      }) as Mat<Uint16Array>;
      mat = vision!.convertType(raw, "8U", scale8);
    } else if (dtype === "U16") {
      const bytes = stripRowPadding(decompressed, stride, rowWidth * channels * 2, rows);
      const buffer = frameBuffer(bytes, dtype);
      const raw = Object.assign(new Uint16Array(buffer), {
        shape: [...shape],
        channels,
      }) as Mat<Uint16Array>;
      // Same scaling the live save/preview paths use: full scale = the
      // significant bit depth, not the container width (12p → /4095).
      mat = vision!.convertType(raw, "8U", scale8);
    } else {
      const bytes = stripRowPadding(decompressed, stride, rowWidth * channels, rows);
      const buffer = frameBuffer(bytes, dtype);
      mat = Object.assign(new Uint8Array(buffer), {
        shape: [...shape],
        channels,
      }) as Mat<Uint8Array>;
    }
    // Demosaic to RGB (1ch → 3ch) — FrameView renders RGB(A) byte order.
    if (bayer) mat = vision!.cvtColor(mat, bayer);
    return mat;
  };
}
