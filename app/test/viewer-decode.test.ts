// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Viewer decode: `/codec` suffix chain + 12p unpack (multi-fovea-recording
// rulings 6/9). The pure helpers (split / decompress / unpack) are exercised
// directly; the vision-backed packed+bayer path is proven by the core Vision
// integration in viewer.test.ts, so here we cover a NON-vision `/zlib`-over-U8
// round trip end to end through the decoder factory.

import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  splitCodecs,
  decompressChain,
  unpack12p,
  createFrameDecoder,
} from "@orchestrator/viewer/decode";

// The PACKED decode branch (unpack12p → convertType with the significantBits-
// derived scale) needs core Vision. Stub it to apply the scale it is handed so
// the test can OBSERVE that the advertiser's significantBits — written VERBATIM
// into channel metadata by the recorder — drives the 8-bit downscale, without a
// native core build. Pure-U8 channels never import Vision, so this is inert for
// the other tests in this file.
vi.mock("core/Vision", () => ({
  convertType: (
    mat: Uint16Array & { shape: number[]; channels: number },
    _dtype: string,
    scale: number,
  ) =>
    Object.assign(
      Uint8Array.from(mat, (v: number) => Math.round(v * scale)),
      { shape: mat.shape, channels: mat.channels },
    ),
}));

describe("splitCodecs", () => {
  it("splits a base format off its codec suffix chain (apply order)", () => {
    expect(splitCodecs("BayerRG12p")).toEqual({ base: "BayerRG12p", codecs: [] });
    expect(splitCodecs("BayerRG12p/zlib")).toEqual({
      base: "BayerRG12p",
      codecs: ["zlib"],
    });
    expect(splitCodecs("Mono8/a/b")).toEqual({ base: "Mono8", codecs: ["a", "b"] });
  });
});

describe("decompressChain", () => {
  it("undoes zlib and is a no-op for an empty chain", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 250, 0, 128]);
    const z = new Uint8Array(deflateSync(payload));
    expect(Array.from(decompressChain(z, ["zlib"]))).toEqual(Array.from(payload));
    expect(decompressChain(payload, [])).toBe(payload);
  });

  it("throws for an unknown codec (channel is skipped by the player)", () => {
    expect(() => decompressChain(new Uint8Array([0]), ["bz2"])).toThrow(/unsupported/);
  });
});

describe("unpack12p", () => {
  it("unpacks 2 samples from 3 bytes per the GenICam layout", () => {
    // s0 = 0xABC (2748), s1 = 0x123 (291):
    //   b0 = s0 & 0xFF        = 0xBC
    //   b1 = (s1&0xF)<<4 | s0>>8 = (0x3<<4)|0xA = 0x3A
    //   b2 = s1 >> 4          = 0x12
    const bytes = new Uint8Array([0xbc, 0x3a, 0x12]);
    expect(Array.from(unpack12p(bytes, 2))).toEqual([0xabc, 0x123]);
  });

  it("handles a full even-width row and stays in 0..4095", () => {
    // 4 samples → 6 bytes. Round-trip a couple of packed pairs.
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0x00, 0xf0, 0x00]);
    const out = unpack12p(bytes, 4);
    expect(out.length).toBe(4);
    for (const v of out) expect(v).toBeLessThanOrEqual(4095);
    expect(out[0]).toBe(0xfff); // b0=0xFF, b1 low nibble 0xF → 0xFFF
  });

  it("handles a trailing odd sample from 1.5 bytes", () => {
    // 1 sample from b0=0x34, b1 low nibble 0x2 → 0x234.
    const bytes = new Uint8Array([0x34, 0x02]);
    expect(Array.from(unpack12p(bytes, 1))).toEqual([0x234]);
  });
});

describe("createFrameDecoder — /zlib over U8 (no vision)", () => {
  it("decompresses each frame then reshapes the base U8 mat", async () => {
    const width = 4;
    const height = 2;
    const decode = await createFrameDecoder({
      dtype: "U8",
      shape: JSON.stringify([height, width]),
      channels: "1",
      pixelFormat: "Mono8/zlib",
      significantBits: "8",
    });
    const frame = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const mat = decode(new Uint8Array(deflateSync(frame)));
    expect(Array.from(mat as unknown as Uint8Array)).toEqual(Array.from(frame));
    expect((mat as unknown as { shape: number[] }).shape).toEqual([height, width]);
  });
});

describe("createFrameDecoder — significantBits honored on a <fmt>/zlib packed stream", () => {
  it("scales by the advertiser significantBits carried verbatim in metadata", async () => {
    const width = 2;
    const height = 1;
    // Two 12-bit samples packed in 3 bytes: s0 = 0xFFF (4095), s1 = 0x000.
    const packed = new Uint8Array([0xff, 0x0f, 0x00]);
    const decode12 = await createFrameDecoder({
      dtype: "U8", // packed/codec channels ride the wire as opaque U8
      shape: JSON.stringify([height, width]),
      channels: "1",
      pixelFormat: "Mono12p/zlib", // packed base + zlib codec (a /zlib pipe)
      significantBits: "12",
    });
    const out12 = decode12(new Uint8Array(deflateSync(packed)));
    // 4095 * 255/4095 = 255; 0 → 0 — the 12-bit downscale (/4095), not the
    // container width. This is the significantBits the advertiser injected and
    // the recorder copied verbatim into the channel metadata.
    expect(Array.from(out12 as unknown as Uint8Array)).toEqual([255, 0]);

    // Guard the silent wrong-bit-depth regression: the SAME bytes with a
    // different significantBits scale differently — the metadata is honored
    // VERBATIM, never re-derived from the base format.
    const decode16 = await createFrameDecoder({
      dtype: "U8",
      shape: JSON.stringify([height, width]),
      channels: "1",
      pixelFormat: "Mono12p/zlib",
      significantBits: "16",
    });
    const out16 = decode16(new Uint8Array(deflateSync(packed)));
    expect((out16 as unknown as Uint8Array)[0]).toBe(Math.round(4095 * (255 / 65535)));
    expect((out16 as unknown as Uint8Array)[0]).not.toBe(255);
  });
});
