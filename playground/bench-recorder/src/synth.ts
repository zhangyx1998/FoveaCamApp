// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Synthetic frame generation for the recorder container bench.
//
// Real sensor raw frames are NOT random bytes: they have spatial correlation
// (scene content, demosaic-adjacent structure) plus a noise floor (photon +
// read noise). Feeding compressors either all-zero or all-random data would
// give a meaningless ratio in either direction, so we synthesize a plausible
// 12-bit scene (low-frequency content + Gaussian-ish noise, ~10-14 LSB sigma)
// and pack it using the same bit layout Aravis/GenICam use for `*12p`
// pixel formats (2 pixels -> 3 bytes), so the byte-level compressibility test
// is representative of what the recorder will actually see once 12-bit
// packed capture is wired end to end (see project_12bit_readout).
//
// This is a methodology choice, not a measurement of real camera data -- see
// the caveat in RESULTS.md.

/** Pack an array of 12-bit samples (0..4095) using GenICam `*12p` layout. */
export function pack12p(samples: Uint16Array): Uint8Array {
  const n = samples.length;
  const out = new Uint8Array(Math.ceil((n * 3) / 2));
  let oi = 0;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    const a = samples[i]! & 0xfff;
    const b = samples[i + 1]! & 0xfff;
    out[oi++] = a & 0xff;
    out[oi++] = ((b & 0x0f) << 4) | (a >> 8);
    out[oi++] = b >> 4;
  }
  if (i < n) {
    const a = samples[i]! & 0xfff;
    out[oi++] = a & 0xff;
    out[oi++] = (a >> 8) & 0x0f;
  }
  return out;
}

/** Small xorshift32 PRNG - fast, deterministic, no crypto overhead. */
function xorshift32(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 0xffffffff);
  };
}

/** Generate one plausible 12-bit scene of width*height samples. */
function genScene12(width: number, height: number, seed: number): Uint16Array {
  const rand = xorshift32(seed);
  // Box-Muller for a Gaussian-ish noise floor (~12 LSB sigma - typical for a
  // 12-bit sensor at moderate gain).
  const gauss = () => {
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const out = new Uint16Array(width * height);
  // A handful of low-frequency sinusoids stand in for scene content/vignette.
  const kx1 = (2 * Math.PI * (1 + (seed % 3))) / width;
  const ky1 = (2 * Math.PI * (2 + (seed % 5))) / height;
  const kx2 = (2 * Math.PI * (3 + (seed % 7))) / width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base =
        1800 +
        900 * Math.sin(kx1 * x + ky1 * y) +
        500 * Math.cos(kx2 * x - 0.5 * ky1 * y);
      const noisy = base + 12 * gauss();
      out[y * width + x] = Math.max(0, Math.min(4095, Math.round(noisy)));
    }
  }
  return out;
}

export interface FramePool {
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  /** Pre-baked packed-12p frames to cycle through (avoids re-synthesizing on every tick). */
  readonly frames: readonly Uint8Array[];
}

/**
 * Build a pool of `count` distinct synthetic packed-12p frames targeting
 * `targetBytes`. Width/height are chosen close to a square so the sinusoid
 * pattern above looks plausible; exact byte length is reported back since
 * 12p packing (3 bytes / 2 px) does not divide every target evenly.
 */
export function buildFramePool(
  targetBytes: number,
  count = 6,
  seedBase = 1,
): FramePool {
  const pixelCount = Math.round((targetBytes * 2) / 3);
  const side = Math.round(Math.sqrt(pixelCount));
  const width = side;
  const height = Math.round(pixelCount / side);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const scene = genScene12(width, height, seedBase + i * 101);
    frames.push(pack12p(scene));
  }
  return { width, height, byteLength: frames[0]!.byteLength, frames };
}

/** Simpler 8-bit processed-stream synthetic payload (e.g. a disparity/mask map). */
export function buildProcessedPool(
  targetBytes: number,
  count = 6,
  seedBase = 5000,
): FramePool {
  const width = Math.round(Math.sqrt(targetBytes));
  const height = Math.round(targetBytes / width);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const rand = xorshift32(seedBase + i * 131);
    const buf = new Uint8Array(width * height);
    const k = (2 * Math.PI * (1 + (i % 4))) / width;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const base = 128 + 90 * Math.sin(k * x + 0.7 * k * y);
        const noisy = base + (rand() - 0.5) * 20;
        buf[y * width + x] = Math.max(0, Math.min(255, Math.round(noisy)));
      }
    }
    frames.push(buf);
  }
  return { width, height, byteLength: frames[0]!.byteLength, frames };
}
