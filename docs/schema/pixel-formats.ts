// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// SINGLE SOURCE OF TRUTH for the sensor pixel-format registry (B-P1).
//
// Every hand-maintained format list — the C++ `Arv::PixelFormat` enum + its
// string/Aravis/cv::Format switches + `significantBits`/`isPacked` helpers
// (core/lib/Aravis/PixelFormat.*), the TS `PixelFormat` union, and the fcap
// dtype/Bayer maps — derives from THIS table. The C++ header
// (core/lib/Aravis/PixelFormat.gen.h) and the Python mirror
// (pyfcap/src/fcap/pixel_formats.py) are GENERATED and checked in via
//   /opt/homebrew/bin/node docs/schema/generate-pixel-formats.ts
// (a trivial emitter — NOT wired into any build). Edit this table, regenerate,
// and commit the artifacts together. TS consumers (viewer decode, dtype
// helpers) import this module directly; C-P6 owns their conformance tests.
//
// Row order is load-bearing: it fixes the C++ enum's underlying uint8_t values,
// which are NOT part of the wire/API contract but must stay stable across a
// rebuild. Append new formats at the end.

export type Dtype = "U8" | "U16";

/** cv::Format member (core/lib/Aravis/PixelFormat.h) each format decodes into. */
export type CvFormat = "U8C1" | "U8C3" | "U8C4" | "U16C1";

/** Bayer mosaic prefix, or null for non-Bayer (mono/RGB) formats. */
export type BayerPattern = "BayerGR" | "BayerRG" | "BayerGB" | "BayerBG";

export interface PixelFormatSpec {
  /** Canonical name — the C++ enum member, the string form, and the TS union member. */
  readonly name: string;
  /** GenICam/Aravis macro this format maps to/from (ARV_PIXEL_FORMAT_*). */
  readonly aravis: string;
  /** cv::Format the native readout produces (12p unpacks to a 16-bit container). */
  readonly cv: CvFormat;
  /** Short dtype of the decoded container (12p samples live in U16 once unpacked). */
  readonly dtype: Dtype;
  /** Channel count of the decoded Mat. */
  readonly channels: number;
  /** Significant bit depth: 12p carries 12 bits in a 16-bit container (scale by 4095, not 65535). */
  readonly significantBits: number;
  /** True for GenICam 12p wire formats, which need bit-unpacking (not memcpy). */
  readonly isPacked: boolean;
  /** Bayer mosaic prefix if this is a raw Bayer format, else null. */
  readonly bayer: BayerPattern | null;
}

export const PIXEL_FORMATS: readonly PixelFormatSpec[] = [
  { name: "Mono8", aravis: "ARV_PIXEL_FORMAT_MONO_8", cv: "U8C1", dtype: "U8", channels: 1, significantBits: 8, isPacked: false, bayer: null },
  { name: "Mono16", aravis: "ARV_PIXEL_FORMAT_MONO_16", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 16, isPacked: false, bayer: null },
  { name: "RGB8", aravis: "ARV_PIXEL_FORMAT_RGB_8_PACKED", cv: "U8C3", dtype: "U8", channels: 3, significantBits: 8, isPacked: false, bayer: null },
  { name: "BGR8", aravis: "ARV_PIXEL_FORMAT_BGR_8_PACKED", cv: "U8C3", dtype: "U8", channels: 3, significantBits: 8, isPacked: false, bayer: null },
  { name: "RGBA8", aravis: "ARV_PIXEL_FORMAT_RGBA_8_PACKED", cv: "U8C4", dtype: "U8", channels: 4, significantBits: 8, isPacked: false, bayer: null },
  { name: "BGRA8", aravis: "ARV_PIXEL_FORMAT_BGRA_8_PACKED", cv: "U8C4", dtype: "U8", channels: 4, significantBits: 8, isPacked: false, bayer: null },
  { name: "BayerGR8", aravis: "ARV_PIXEL_FORMAT_BAYER_GR_8", cv: "U8C1", dtype: "U8", channels: 1, significantBits: 8, isPacked: false, bayer: "BayerGR" },
  { name: "BayerRG8", aravis: "ARV_PIXEL_FORMAT_BAYER_RG_8", cv: "U8C1", dtype: "U8", channels: 1, significantBits: 8, isPacked: false, bayer: "BayerRG" },
  { name: "BayerGB8", aravis: "ARV_PIXEL_FORMAT_BAYER_GB_8", cv: "U8C1", dtype: "U8", channels: 1, significantBits: 8, isPacked: false, bayer: "BayerGB" },
  { name: "BayerBG8", aravis: "ARV_PIXEL_FORMAT_BAYER_BG_8", cv: "U8C1", dtype: "U8", channels: 1, significantBits: 8, isPacked: false, bayer: "BayerBG" },
  { name: "BayerGR16", aravis: "ARV_PIXEL_FORMAT_BAYER_GR_16", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 16, isPacked: false, bayer: "BayerGR" },
  { name: "BayerRG16", aravis: "ARV_PIXEL_FORMAT_BAYER_RG_16", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 16, isPacked: false, bayer: "BayerRG" },
  { name: "BayerGB16", aravis: "ARV_PIXEL_FORMAT_BAYER_GB_16", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 16, isPacked: false, bayer: "BayerGB" },
  { name: "BayerBG16", aravis: "ARV_PIXEL_FORMAT_BAYER_BG_16", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 16, isPacked: false, bayer: "BayerBG" },
  // GenICam 12-bit packed (12p): 2 pixels in 3 bytes, unpacked to CV_16UC1.
  { name: "Mono12p", aravis: "ARV_PIXEL_FORMAT_MONO_12P", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 12, isPacked: true, bayer: null },
  { name: "BayerGR12p", aravis: "ARV_PIXEL_FORMAT_BAYER_GR_12P", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 12, isPacked: true, bayer: "BayerGR" },
  { name: "BayerRG12p", aravis: "ARV_PIXEL_FORMAT_BAYER_RG_12P", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 12, isPacked: true, bayer: "BayerRG" },
  { name: "BayerGB12p", aravis: "ARV_PIXEL_FORMAT_BAYER_GB_12P", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 12, isPacked: true, bayer: "BayerGB" },
  { name: "BayerBG12p", aravis: "ARV_PIXEL_FORMAT_BAYER_BG_12P", cv: "U16C1", dtype: "U16", channels: 1, significantBits: 12, isPacked: true, bayer: "BayerBG" },
] as const;

/** All canonical format names, in enum order. */
export const PIXEL_FORMAT_NAMES = PIXEL_FORMATS.map((f) => f.name);

/** Distinct Bayer mosaic prefixes, in first-seen order. */
export const BAYER_PATTERNS: readonly BayerPattern[] = [
  ...new Set(PIXEL_FORMATS.map((f) => f.bayer).filter((b): b is BayerPattern => b !== null)),
];

const BY_NAME = new Map(PIXEL_FORMATS.map((f) => [f.name, f]));

/** Look up a format spec by name (undefined if unknown). */
export function pixelFormatSpec(name: string): PixelFormatSpec | undefined {
  return BY_NAME.get(name);
}

// ---- Bayer → OpenCV demosaic-constant prefix -------------------------------
// OpenCV's `COLOR_BayerXX2*` enum naming is OFF-BY-ONE vs the GenICam/PFNC
// sensor naming: the physically correct OpenCV constant for a GenICam BayerYY
// mosaic has R and B swapped (greens stay on the same diagonal — a PURE R/B
// swap, NO demosaic phase shift). Empirically proven in
// docs/proposals/channel-order-fix.md (a synthetic pure-red RGGB mosaic through
// both constants). THIS is the single place the swap is encoded: the C++
// `cvtColorCode` table (via the generated FOVEA_BAYER_CV_FORMATS macro), the
// viewer's `decode.ts`, and the capture save path all derive their demosaic
// constant from here so the three sites can NEVER drift.
const BAYER_RB_SWAP: Readonly<Record<BayerPattern, BayerPattern>> = {
  BayerGR: "BayerGB",
  BayerRG: "BayerBG",
  BayerGB: "BayerGR",
  BayerBG: "BayerRG",
};

/** The OpenCV Bayer constant prefix (`cv::COLOR_<prefix>2*`) that correctly
 *  demosaics a GenICam `bayer` mosaic, carrying the OpenCV↔PFNC R/B off-by-one
 *  correction. */
export function cvBayerPrefix(bayer: BayerPattern): BayerPattern {
  return BAYER_RB_SWAP[bayer];
}
