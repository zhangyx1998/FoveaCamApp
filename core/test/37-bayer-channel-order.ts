// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// channel-order-fix.md empirical PIN: OpenCV's `COLOR_BayerXX2*` enum naming is
// off-by-one vs the GenICam/PFNC sensor naming, so the correct demosaic constant
// for a GenICam BayerYY mosaic has R and B swapped. `cvBayerPrefix` (the single
// source the C++ `cvtColorCode` table, the viewer decode, and the capture path
// all derive from) MUST pick the constant that lands RED in the right channel.
//
// Proof: a synthetic PURE-RED RGGB mosaic (only the R photosites carry signal).
//  - the REGISTRY constant `${cvBayerPrefix("BayerRG")}2RGB` (= BayerBG2RGB)
//    demosaics red into channel 0 (honest RGB) and leaves channel 2 (B) zero;
//  - the LITERAL PFNC-named constant `BayerRG2RGB` demosaics red into channel 2
//    (the off-by-one that swapped R/B on every live preview before the fix).
// If the registry ever regresses to the literal name, red lands in ch2 here and
// this test fails.

import assert from "node:assert";
import { cvtColor } from "core/Vision";
import { cvBayerPrefix } from "../../docs/schema/pixel-formats.ts";

const W = 16;
const H = 16;

// RGGB mosaic (GenICam BayerRG): row-major 2x2 tile
//   R G
//   G B
// Pure-red scene ⇒ R sites = 255, every G / B site = 0.
function pureRedRGGB() {
  const buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      buf[y * W + x] = y % 2 === 0 && x % 2 === 0 ? 255 : 0;
  return Object.assign(buf, { shape: [H, W], channels: 1 });
}

/** Per-channel extremes over an RGB Mat (channels-last, 3ch). */
function channelStats(mat: Uint8Array) {
  const max = [0, 0, 0];
  const anyFull = [false, false, false];
  for (let i = 0; i < mat.length; i += 3)
    for (let c = 0; c < 3; c++) {
      max[c] = Math.max(max[c]!, mat[i + c]!);
      if (mat[i + c] === 255) anyFull[c] = true;
    }
  return { max, anyFull };
}

const mosaic = pureRedRGGB();

// --- 1: the registry-derived constant lands RED in channel 0 (honest RGB) ----
const goodCode = `${cvBayerPrefix("BayerRG")}2RGB`;
assert.equal(goodCode, "BayerBG2RGB", "registry picks the R/B-swapped OpenCV prefix");
const good = cvtColor(mosaic, goodCode as never) as unknown as Uint8Array;
const g = channelStats(good);
assert.equal(g.anyFull[0], true, "corrected demosaic: RED reaches channel 0 (R)");
assert.equal(g.max[2], 0, "corrected demosaic: channel 2 (B) stays zero for a pure-red scene");

// --- 2: the LITERAL PFNC-named constant lands RED in channel 2 (the bug) -----
const bad = cvtColor(mosaic, "BayerRG2RGB" as never) as unknown as Uint8Array;
const b = channelStats(bad);
assert.equal(b.anyFull[2], true, "literal (off-by-one) constant: RED wrongly lands in channel 2 (B)");
assert.equal(b.max[0], 0, "literal constant: channel 0 (R) stays zero — proves the R/B swap is real");

// The two constants are NOT interchangeable — the whole point of the fix.
assert.notEqual(goodCode, "BayerRG2RGB", "corrected and literal constants must differ");

console.log(
  `37-bayer-channel-order: cvBayerPrefix("BayerRG")=${cvBayerPrefix("BayerRG")} → ${goodCode} ` +
    "puts RED in ch0; literal BayerRG2RGB puts RED in ch2 (off-by-one) OK.",
);
