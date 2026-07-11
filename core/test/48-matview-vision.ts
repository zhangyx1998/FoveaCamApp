// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// MatView adoption in the Vision kernels (value-sweep 2026-07-11,
// mat-convert-full-copy-per-vision-call) — NO hardware. The hot READ-ONLY
// kernels (slice, cvtColor, gaussian, diff, minMaxLoc, matchTemplate,
// heatmap, wrapPerspective, disparity) now take a zero-copy Mat header over
// the caller's TypedArray instead of memcpy'ing the input. Proves:
//   1. CONFORMANCE — each adopted kernel still computes the same result
//      (golden per-pixel expectations / planted-feature checks).
//   2. NO INPUT MUTATION — the aliasing audit holds: every kernel leaves the
//      caller's buffer byte-identical (the in-place normalize/blur/CLAHE
//      paths were restructured to write into distinct Mats).
//   3. MICRO-BENCH — ns/call and MB/s of eliminated copy for the display
//      kernel's hottest calls (cvtColor, slice, minMaxLoc), comparing the
//      zero-copy call against the same call plus an explicit input copy
//      (what the old converter did on every invocation).
//
// Run UNSANDBOXED: node core/test/48-matview-vision.ts

import assert from "node:assert/strict";
import { Vision } from "core";

type Mat = Uint8Array & { shape: number[]; channels: number };
type MatF32 = Float32Array & { shape: number[]; channels: number };
type Mat16S = Int16Array & { shape: number[]; channels: number };

const V = Vision as unknown as {
  slice(m: Mat, r: { x: number; y: number; width: number; height: number }): Mat;
  cvtColor(m: Mat, code: string): Mat;
  gaussian(m: Mat, k: number, sigmaX?: number): Mat;
  diff(a: Mat, b: Mat, norm?: boolean): Mat;
  minMaxLoc(m: Mat): { min: { x: number; y: number; value: number }; max: { x: number; y: number; value: number } };
  matchTemplate(h: Mat, n: Mat, method?: string): Promise<MatF32>;
  heatmap(m: Mat, norm?: boolean): Mat;
  wrapPerspective(m: Mat, h: MatF32 | Float64Array, mode?: string): Mat;
  disparity(l: Mat, r: Mat, numDisparities?: number, blockSize?: number): Mat16S;
};

function mat(w: number, h: number, ch: number, fill: (x: number, y: number, c: number) => number): Mat {
  const m = new Uint8Array(w * h * ch) as Mat;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < ch; c++) m[(y * w + x) * ch + c] = fill(x, y, c) & 0xff;
  m.shape = [h, w];
  m.channels = ch;
  return m;
}

/** Run `fn`, assert the input buffer is byte-identical afterwards. */
async function assertNoMutation<T>(input: Mat, label: string, fn: () => T | Promise<T>): Promise<T> {
  const before = Uint8Array.from(input); // plain byte copy (no shape/channels)
  const out = await fn();
  assert.equal(
    Buffer.compare(Buffer.from(input.buffer, input.byteOffset, input.byteLength), Buffer.from(before.buffer)),
    0,
    `${label}: input buffer must not be mutated`,
  );
  return out;
}

const W = 320, H = 240;

// --- 1: slice — golden ROI + zero-fill out of bounds --------------------------
{
  const src = mat(W, H, 1, (x, y) => (x + y) % 251);
  const out = await assertNoMutation(src, "slice", () =>
    V.slice(src, { x: 10, y: 20, width: 8, height: 4 }),
  );
  assert.deepEqual(out.shape, [4, 8], "slice shape");
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++)
      assert.equal(out[y * 8 + x], (10 + x + 20 + y) % 251, `slice pixel ${x},${y}`);
  // Out-of-bounds slice zero-fills the outside region.
  const edge = V.slice(src, { x: -2, y: 0, width: 4, height: 1 });
  assert.equal(edge[0], 0, "oob left is zero-filled");
  assert.equal(edge[2], (0 + 0) % 251, "in-bounds part copied");
  console.log("48-matview-vision: slice conformance + no-mutation OK.");
}

// --- 2: cvtColor — RGBA→GRAY golden (BT.601 weights, OpenCV rounding) ---------
{
  const src = mat(W, H, 4, (x, y, c) => (c === 3 ? 255 : (x * (c + 1) + y) % 256));
  const gray = await assertNoMutation(src, "cvtColor", () => V.cvtColor(src, "RGBA2GRAY"));
  assert.equal(gray.channels, 1, "gray is single channel");
  // Spot-check a few pixels against the BT.601 formula (±1 for fixed-point).
  for (const [x, y] of [[0, 0], [37, 101], [W - 1, H - 1]] as const) {
    const i = (y * W + x) * 4;
    const expected = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    assert(
      Math.abs(gray[y * W + x] - expected) <= 1,
      `cvtColor pixel ${x},${y}: ${gray[y * W + x]} ≈ ${expected}`,
    );
  }
  console.log("48-matview-vision: cvtColor conformance + no-mutation OK.");
}

// --- 3: gaussian — input untouched (the old path blurred a private copy) ------
{
  const src = mat(W, H, 1, (x, y) => ((x ^ y) * 7) % 256);
  const blurred = await assertNoMutation(src, "gaussian", () => V.gaussian(src, 5, 2));
  assert.deepEqual(blurred.shape, [H, W], "gaussian shape preserved");
  let differs = 0;
  for (let i = 0; i < src.length; i += 97) if (blurred[i] !== src[i]) differs++;
  assert(differs > 0, "gaussian output actually blurred (differs from input)");
  // Blur preserves a constant region exactly — golden invariant.
  const flat = mat(64, 64, 1, () => 128);
  const flatBlur = V.gaussian(flat, 5, 2);
  assert(flatBlur.every((v) => v === 128), "gaussian of a constant is constant");
  console.log("48-matview-vision: gaussian conformance + no-mutation OK.");
}

// --- 4: diff — R=a, B=b, G=min golden; norm path must not mutate (CLAHE fix) --
{
  const a = mat(64, 48, 1, (x) => x * 3);
  const b = mat(64, 48, 1, (_, y) => y * 5);
  const out = await assertNoMutation(a, "diff(a)", () =>
    assertNoMutation(b, "diff(b)", () => V.diff(a, b)),
  );
  assert.equal(out.channels, 4, "diff is RGBA");
  for (const [x, y] of [[3, 7], [50, 40]] as const) {
    const i = (y * 64 + x) * 4;
    assert.equal(out[i + 0], a[y * 64 + x], "diff R = a");
    assert.equal(out[i + 2], b[y * 64 + x], "diff B = b");
    assert.equal(out[i + 1], 0, "diff G = black");
    assert.equal(out[i + 3], 255, "diff A = opaque");
  }
  // norm=true routes through CLAHE — the exact path that used to write
  // IN PLACE into an already-gray input.
  await assertNoMutation(a, "diff norm (a)", () =>
    assertNoMutation(b, "diff norm (b)", () => V.diff(a, b, true)),
  );
  console.log("48-matview-vision: diff conformance + no-mutation (incl. CLAHE) OK.");
}

// --- 5: minMaxLoc — planted extrema ------------------------------------------
{
  const src = mat(W, H, 1, () => 100);
  src[57 * W + 13] = 3;   // planted min at (13, 57)
  src[201 * W + 300] = 251; // planted max at (300, 201)
  const r = await assertNoMutation(src, "minMaxLoc", () => V.minMaxLoc(src));
  assert.deepEqual(
    { x: r.min.x, y: r.min.y, v: r.min.value },
    { x: 13, y: 57, v: 3 },
    "min found",
  );
  assert.deepEqual(
    { x: r.max.x, y: r.max.y, v: r.max.value },
    { x: 300, y: 201, v: 251 },
    "max found",
  );
  console.log("48-matview-vision: minMaxLoc conformance + no-mutation OK.");
}

// --- 6: matchTemplate (ASYNC — shared_ptr'd views) — planted template ----------
{
  const hay = mat(W, H, 1, (x, y) => ((x * 31 + y * 17) ^ (x >> 2)) % 256);
  const NX = 210, NY = 60, NW = 24, NH = 16;
  const needle = mat(NW, NH, 1, (x, y) => hay[(NY + y) * W + (NX + x)]);
  const res = await assertNoMutation(hay, "matchTemplate(hay)", () =>
    assertNoMutation(needle, "matchTemplate(needle)", () =>
      V.matchTemplate(hay, needle, "SQDIFF_NORMED"),
    ),
  );
  // Best (lowest SQDIFF) at the planted origin.
  const rw = W - NW + 1;
  let best = Infinity, bx = -1, by = -1;
  for (let y = 0; y < H - NH + 1; y++)
    for (let x = 0; x < rw; x++) {
      const v = res[y * rw + x];
      if (v < best) { best = v; bx = x; by = y; }
    }
  assert.deepEqual({ bx, by }, { bx: NX, by: NY }, "template found at planted origin");
  assert(best < 1e-6, "planted match is exact");
  console.log("48-matview-vision: matchTemplate conformance + no-mutation OK.");
}

// --- 7: heatmap — golden RGBA mapping; norm path must not mutate --------------
{
  const src = mat(64, 32, 1, (x, y) => (x * 4 + y) % 256);
  const hm = await assertNoMutation(src, "heatmap", () => V.heatmap(src));
  assert.equal(hm.channels, 4, "heatmap is RGBA");
  for (const [x, y] of [[5, 9], [60, 30]] as const) {
    const v = src[y * 64 + x];
    const i = (y * 64 + x) * 4;
    assert.equal(hm[i + 0], v, "heatmap R = v");
    assert.equal(hm[i + 2], 255 - v, "heatmap B = 255 - v");
    assert.equal(hm[i + 1], Math.min(v, 255 - v), "heatmap G = min(R,B)");
    assert.equal(hm[i + 3], 255, "heatmap A = opaque");
  }
  // norm=true is the path that used to normalize IN PLACE on its private copy.
  await assertNoMutation(src, "heatmap norm", () => V.heatmap(src, true));
  console.log("48-matview-vision: heatmap conformance + no-mutation OK.");
}

// --- 8: wrapPerspective — identity homography reproduces the input -------------
{
  const src = mat(64, 48, 1, (x, y) => (x * 5 + y * 3) % 256);
  const eye = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) as unknown as MatF32;
  (eye as unknown as Mat).shape = [3, 3];
  (eye as unknown as Mat).channels = 1;
  const out = await assertNoMutation(src, "wrapPerspective", () =>
    V.wrapPerspective(src, eye, "NEAREST"),
  );
  assert.deepEqual(Uint8Array.from(out), Uint8Array.from(src), "identity warp = input");
  console.log("48-matview-vision: wrapPerspective conformance + no-mutation OK.");
}

// --- 9: disparity — runs on views, returns 16S, inputs untouched ---------------
{
  // A vertically-striped pair with a horizontal shift — StereoBM finds
  // SOMETHING; the conformance here is type/shape/no-mutation (the tuned
  // stereo brick has its own numeric suite).
  const l = mat(128, 96, 1, (x, y) => ((x >> 2) * 40 + y) % 256);
  const r = mat(128, 96, 1, (x, y) => (((x + 4) >> 2) * 40 + y) % 256);
  const d = await assertNoMutation(l, "disparity(l)", () =>
    assertNoMutation(r, "disparity(r)", () => V.disparity(l, r, 16, 15)),
  );
  assert(d instanceof Int16Array, "disparity is CV_16S");
  assert.deepEqual(d.shape, [96, 128], "disparity shape");
  console.log("48-matview-vision: disparity conformance + no-mutation OK.");
}

// --- 10: micro-bench — zero-copy vs the old copy-per-call ----------------------
{
  // Display-kernel-shaped input: 1920×1200 RGBA8 (9.2 MB per call, the frame
  // the old converter memcpy'd on EVERY Vision call).
  const BW = 1920, BH = 1200;
  const big = new Uint8Array(BW * BH * 4) as Mat;
  for (let i = 0; i < big.length; i += 4097) big[i] = i % 251;
  big.shape = [BH, BW];
  big.channels = 4;
  const ITERS = 50;

  const benchNs = (fn: () => void): number => {
    fn(); // warm
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITERS; i++) fn();
    return Number(process.hrtime.bigint() - t0) / ITERS;
  };

  // AFTER: the zero-copy call as shipped.
  const zeroCopy = benchNs(() => void V.cvtColor(big, "RGBA2GRAY"));
  // BEFORE-equivalent: the same call plus one full input copy — exactly the
  // memcpy the old convert<cv::Mat> performed per invocation (the JS-side
  // slice() is the same bytes through the same memory system).
  const withCopy = benchNs(() => {
    const copy = big.slice() as Mat;
    copy.shape = big.shape;
    copy.channels = big.channels;
    void V.cvtColor(copy, "RGBA2GRAY");
  });
  const savedNsPerCall = withCopy - zeroCopy;
  const mb = big.byteLength / (1024 * 1024);
  console.log(
    `48-matview-vision: BENCH cvtColor(${BW}x${BH} RGBA, ${mb.toFixed(1)} MB): ` +
      `zero-copy ${(zeroCopy / 1e6).toFixed(2)} ms/call vs +input-copy ` +
      `${(withCopy / 1e6).toFixed(2)} ms/call — ~${(savedNsPerCall / 1e6).toFixed(2)} ms ` +
      `and ${mb.toFixed(1)} MB of copy eliminated per call`,
  );

  const zeroSlice = benchNs(() => void V.slice(big, { x: 100, y: 100, width: 256, height: 256 }));
  const copySlice = benchNs(() => {
    const copy = big.slice() as Mat;
    copy.shape = big.shape;
    copy.channels = big.channels;
    void V.slice(copy, { x: 100, y: 100, width: 256, height: 256 });
  });
  console.log(
    `48-matview-vision: BENCH slice(256² of ${BW}x${BH}): zero-copy ` +
      `${(zeroSlice / 1e6).toFixed(2)} ms/call vs +input-copy ${(copySlice / 1e6).toFixed(2)} ms/call`,
  );
  // The zero-copy path must actually be cheaper than paying the input copy.
  assert(zeroCopy < withCopy, "zero-copy cvtColor beats copy-per-call");
  assert(zeroSlice < copySlice, "zero-copy slice beats copy-per-call");
}

console.log("48-matview-vision: MatView vision kernels passed.");
