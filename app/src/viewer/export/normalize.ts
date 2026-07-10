// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Decoded-Mat → RAW `rgba` normalization for the export pipe (viewer-export.md
// pipeline). Mirrors `FrameView.vue`'s `expandToRGBA` EXACTLY so an exported
// frame matches what the viewer shows: 1ch → gray replicated, 3ch → RGB + opaque
// alpha, 4ch → passed through (the decode path yields RGBA-ordered bytes — the
// preview-pipe channel-order note). The result is what we pipe to ffmpeg's
// rawvideo `rgba` input. Pure + unit-tested.

/** Expand a decoded frame (row-major, `channels` interleaved) to a tightly
 *  packed WxH·4 RGBA byte buffer, opaque alpha for 1/3-channel sources. A
 *  4-channel source is copied verbatim (already RGBA). `out` is reused when
 *  provided AND correctly sized (the runner keeps a per-stream scratch buffer to
 *  avoid a per-frame allocation). */
export function toRGBA(
  src: Uint8Array,
  channels: number,
  pixels: number,
  out?: Uint8Array,
): Uint8Array {
  const dst = out && out.length === pixels * 4 ? out : new Uint8Array(pixels * 4);
  if (channels === 4) {
    dst.set(src.subarray(0, pixels * 4));
    return dst;
  }
  if (channels === 1) {
    for (let i = 0, j = 0; i < pixels; i++, j += 4) {
      const g = src[i]!;
      dst[j] = g;
      dst[j + 1] = g;
      dst[j + 2] = g;
      dst[j + 3] = 255;
    }
    return dst;
  }
  if (channels === 3) {
    for (let i = 0, j = 0; i < pixels; i++) {
      const s = i * 3;
      dst[j++] = src[s]!;
      dst[j++] = src[s + 1]!;
      dst[j++] = src[s + 2]!;
      dst[j++] = 255;
    }
    return dst;
  }
  throw new Error(`toRGBA: unsupported channel count ${channels}`);
}
