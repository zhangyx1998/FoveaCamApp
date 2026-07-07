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
// 16-bit container — see `stream-decoder.py` and the 12-bit readout
// project), Bayer mosaics are demosaiced to RGB via core Vision's
// `cvtColor`, and the result is a 1/3/4-channel Uint8Array Mat, exactly what
// `FrameView`'s ImageData path renders.
//
// core Vision is imported lazily and only when a channel actually needs it
// (U16 scaling / Bayer demosaic) — pure-U8 channels (Mono8/BGRA8 previews)
// decode with zero native involvement. The factory is async for that reason;
// the returned decoder is synchronous per frame (the player meters it).

import type { Mat } from "core/Vision";
import { typedArrayFrom, type Dtype } from "@lib/util/dtype";

export type FrameDecoder = (bytes: Uint8Array) => Mat<Uint8Array>;

/** The §2b static decode props, parsed out of `FoveaChannel.metadata`. */
export interface DecodeProps {
  dtype: Dtype;
  shape: number[];
  channels: number;
  pixelFormat: string;
  significantBits: number;
}

export function parseDecodeProps(metadata: Record<string, string>): DecodeProps {
  const dtype = metadata.dtype as Dtype;
  const shape = JSON.parse(metadata.shape ?? "[]") as number[];
  if (!dtype || !Array.isArray(shape) || shape.length < 2)
    throw new Error("channel metadata is missing x-fovea-raw decode props");
  return {
    dtype,
    shape,
    channels: Number(metadata.channels ?? "1"),
    pixelFormat: metadata.pixelFormat ?? "Mono8",
    significantBits: Number(metadata.significantBits ?? "8"),
  };
}

type BayerCode = `Bayer${"GR" | "RG" | "GB" | "BG"}2RGB`;

const bayerCode = (pixelFormat: string): BayerCode | null => {
  const m = /^Bayer(GR|RG|GB|BG)/.exec(pixelFormat);
  return m ? (`Bayer${m[1]}2RGB` as BayerCode) : null;
};

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
  const { dtype, shape, channels, pixelFormat, significantBits } = props;
  if (dtype !== "U8" && dtype !== "U16")
    throw new Error(`unsupported preview dtype "${dtype}"`);

  const bayer = bayerCode(pixelFormat);
  const needsVision = dtype === "U16" || bayer !== null;
  const vision = needsVision ? await import("core/Vision") : null;

  return (bytes: Uint8Array): Mat<Uint8Array> => {
    // Copy out of the shared chunk/scan buffer (and realign — message bytes
    // sit at arbitrary offsets, Uint16Array views need 2-byte alignment).
    const buffer = bytes.slice().buffer;
    let mat: Mat<Uint8Array>;
    if (dtype === "U16") {
      const raw = Object.assign(new Uint16Array(buffer), {
        shape: [...shape],
        channels,
      }) as Mat<Uint16Array>;
      // Same scaling the live save/preview paths use: full scale = the
      // significant bit depth, not the container width (12p → /4095).
      mat = vision!.convertType(raw, "8U", 255 / ((1 << significantBits) - 1));
    } else {
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
