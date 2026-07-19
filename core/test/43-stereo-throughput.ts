// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Stereo disparity THROUGHPUT + SIGNED-RANGE bench — NO hardware. Drives the real
// StereoStream brick (attachStereoPipe over two synthetic pair-test sources)
// with camera-res (1440×1080) 2D-noise stereo frames whose PLANAR ground-truth
// disparity is known and SIGNED (±200 px, inside the −256…+255 window).
//
// Per candidate {algorithm, mode, matchScale, wls} at the window
// { numDisparities: 512, minDisparity: −256 }:
//   - QUALITY  — fraction of VALID pixels within ±2 px (full-res units) of the
//     ground truth, on BOTH signs; plus the invalid-pixel rate.
//   - SIGN     — the recovered median must carry the INJECTED sign for both a
//     positive and a negative plane. A contradiction implicates an OPEN
//     H-vs-inverse homography-orientation question (report-only).
//   - FPS      — steady-state emit rate while pairs are pushed faster than the
//     matcher consumes (latest-wins overload; ≥100 frames or a time cap).
// Prints the full result table; asserts the DEFAULT brick params (the bench
// winner baked into StereoParams) meet the ≥55 fps floor + quality bar.
// Also proves live retune across ALL new params (the same setStereoParams
// path callers use) and dims-at-match-scale emission.
//
// Run UNSANDBOXED: node core/test/43-stereo-throughput.ts

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, __origin__ } from "core";

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(join(dirname(__origin__), `${prefix}-shm-reader.node`)) as {
  open(seg: string): object;
  readInto(h: object, dest: ArrayBuffer, lastSeq: bigint):
    | { seq: bigint; width: number; height: number; closed?: undefined }
    | { closed: true }
    | null;
  close(h: object): void;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const P = Pipe as any;
const A = Aravis as any;

// --- geometry / ruled params -------------------------------------------------
const W = 1440;
const H = 1080;
const CH = 4;
const MARGIN = 300; // master-texture side margin ≥ |d|max
const D_POS = 200; // injected plane disparities (both signs, inside ±256)
const D_NEG = -200;
const WINDOW = { numDisparities: 512, minDisparity: -256 }; // sgbm-signed-range.md
const VALID_MIN = WINDOW.minDisparity; // any value below is the invalid marker
const FPS_FLOOR = 55; // stereo-throughput.md selection gate
const QUALITY_BAR = 0.75; // fraction of valid px within ±2 px, worst sign

// --- synthetic stereo pair ----------------------------------------------------
// A seeded 2D value-noise master texture (deterministic xorshift + one blur
// pass — dense unique texture, ideal for block matching). left = the center
// crop; right(d) = the crop shifted so x_left − x_right = d exactly, everywhere.
function makeMaster(): Uint8Array {
  const mw = W + 2 * MARGIN;
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s & 0xff;
  };
  const raw = new Uint8Array(mw * H);
  for (let i = 0; i < raw.length; i++) raw[i] = rnd();
  // One 3×1 + 1×3 smoothing pass (kills single-pixel aliasing under INTER_AREA
  // downscale while keeping the texture dense).
  const sm = new Uint8Array(mw * H);
  for (let y = 0; y < H; y++) {
    const r0 = Math.max(0, y - 1) * mw, r1 = y * mw, r2 = Math.min(H - 1, y + 1) * mw;
    for (let x = 0; x < mw; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(mw - 1, x + 1);
      sm[r1 + x] =
        (raw[r1 + xl]! + raw[r1 + x]! + raw[r1 + xr]! +
          raw[r0 + x]! + raw[r2 + x]!) / 5;
    }
  }
  return sm;
}

/** RGBA crop of the master at horizontal offset `x0` (gray replicated). */
function cropRgba(master: Uint8Array, x0: number): Uint8Array {
  const mw = W + 2 * MARGIN;
  const out = new Uint8Array(W * H * CH);
  for (let y = 0; y < H; y++) {
    const src = y * mw + x0;
    let di = y * W * CH;
    for (let x = 0; x < W; x++) {
      const g = master[src + x]!;
      out[di] = g; out[di + 1] = g; out[di + 2] = g; out[di + 3] = 255;
      di += CH;
    }
  }
  return out;
}

const master = makeMaster();
const leftBuf = cropRgba(master, MARGIN);
// Feature at master column c: x_left = c − MARGIN; right crop at MARGIN + d
// puts it at x_right = c − MARGIN − d ⇒ x_left − x_right = d (standard sign).
const rightBuf: Record<number, Uint8Array> = {
  [D_POS]: cropRgba(master, MARGIN + D_POS),
  [D_NEG]: cropRgba(master, MARGIN + D_NEG),
};

// --- brick under test ----------------------------------------------------------
const L = "test/stereo/src/43/L";
const R = "test/stereo/src/43/R";
const stId = "stereo/bench";
assert.equal(A.createPairTestSource(L), true, "L test source created");
assert.equal(A.createPairTestSource(R), true, "R test source created");
const f32Bytes = W * H * 4;
P.advertise({
  id: stId, pixelFormat: "Disparity32F", dtype: "F32", width: W, height: H,
  channels: 1, stride: W * 4, bytesPerFrame: f32Bytes, ringDepth: 4,
  maxWidth: W, maxHeight: H, maxBytes: f32Bytes,
});
// Attach with the ruled signed window; candidate params ride setStereoParams
// (the SAME live-retune path the sessions use).
assert.equal(A.attachStereoPipe(L, R, stId, { ...WINDOW }), true, "stereo attaches");

const rh = reader.open(P.connect(stId).shmName); // consumer → gate opens
const dest = new ArrayBuffer(f32Bytes);
let lastSeq = 0n;
const pull = () => {
  const r = reader.readInto(rh, dest, lastSeq);
  if (!r || (r as any).closed) return null;
  lastSeq = (r as any).seq;
  return r as { seq: bigint; width: number; height: number };
};

let round = 0;
function pushPair(d: number): void {
  const T0 = BigInt(1_000_000_000 + round * 1_000_000);
  round++;
  A.pushPairTestFrame(R, { deviceTimestamp: T0, width: W, height: H, buffer: rightBuf[d] });
  A.pushPairTestFrame(L, { deviceTimestamp: T0, width: W, height: H, buffer: leftBuf });
}

/** Push pairs until the emitted map SETTLES on the new plane/params, then
 *  return metrics vs ground truth `d`. Two stale hazards straddle a switch:
 *  frames computed with the OLD params (dims mismatch → skipped), and MIXED
 *  pairs — the two synthetic sources are independent threads, so the first
 *  tick(s) after a plane switch can pair the new LEFT with the previous
 *  plane's RIGHT (the left texture is plane-invariant, so such a map reads as
 *  a stable, plausible OLD-plane value). Discipline: skip a minimum number of
 *  fresh frames after the switch, then require THREE consecutive reads with
 *  medians within 1 px. A brick whose SIGN CONVENTION is genuinely flipped
 *  still settles (consistently at −d) — the caller's assert reports it. */
async function measureQuality(d: number, expectScale: number): Promise<{
  validFrac: number; within2: number; median: number;
}> {
  const deadline = Date.now() + 60_000;
  const expectW = Math.floor(W / expectScale);
  const MIN_FRESH = 4;   // frames to discard after the switch (mixed pairs)
  const STABLE_RUN = 3;  // consecutive stable medians required
  let fresh = 0;
  let run: { validFrac: number; within2: number; median: number }[] = [];
  while (Date.now() < deadline) {
    pushPair(d);
    await sleep(10);
    const r = pull();
    if (!r) continue;
    const w = r.width, h = r.height;
    if (w !== expectW) { fresh = 0; run = []; continue; } // stale pre-retune frame
    const view = new Float32Array(dest, 0, w * h);
    let valid = 0, within = 0;
    const vals: number[] = [];
    for (let i = 0; i < view.length; i++) {
      const v = view[i]!;
      if (!Number.isFinite(v) || v < VALID_MIN) continue;
      valid++;
      vals.push(v);
      if (Math.abs(v - d) <= 2) within++;
    }
    if (valid < 0.02 * view.length) { fresh = 0; run = []; continue; } // warmup
    if (++fresh <= MIN_FRESH) { run = []; continue; } // possible mixed pair
    vals.sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length / 2)]!;
    const cur = { validFrac: valid / view.length, within2: within / valid, median };
    if (run.length > 0 && Math.abs(run[run.length - 1]!.median - cur.median) > 1)
      run = []; // discontinuity — restart the stability run
    run.push(cur);
    if (run.length >= STABLE_RUN) return cur; // settled
  }
  throw new Error(`no settled disparity frame for d=${d} within the deadline`);
}

/** Steady-state fps: push pairs (latest-wins overload) for the window, count
 *  emitted frames off the brick meter. */
async function measureFps(d: number): Promise<{ fps: number; frames: number }> {
  // Warm up (matcher rebuild + first computes).
  for (let i = 0; i < 3; i++) { pushPair(d); await sleep(30); }
  const before = A.stereoProbeAll()[stId].outputs.disparity.count as number;
  const t0 = Date.now();
  const budgetMs = 4_000; // ≥100 frames at the 55fps gate; time-capped for slow candidates
  while (Date.now() - t0 < budgetMs) {
    pushPair(d);
    await tick(); // yield so the reader/probe stay serviced; brick thread matches
    const emitted = (A.stereoProbeAll()[stId].outputs.disparity.count as number) - before;
    if (emitted >= 150) break;
  }
  const elapsed = (Date.now() - t0) / 1000;
  const frames = (A.stereoProbeAll()[stId].outputs.disparity.count as number) - before;
  return { fps: frames / elapsed, frames };
}

type Candidate = {
  name: string;
  params: Record<string, unknown>;
  scale: number;
};
const candidates: Candidate[] = [
  { name: "sgbm/full (legacy)", params: { algorithm: "sgbm", mode: "sgbm", matchScale: 1 }, scale: 1 },
  { name: "sgbm/3way s=1", params: { algorithm: "sgbm", mode: "3way", matchScale: 1 }, scale: 1 },
  { name: "sgbm/3way s=2", params: { algorithm: "sgbm", mode: "3way", matchScale: 2 }, scale: 2 },
  { name: "sgbm/3way s=4", params: { algorithm: "sgbm", mode: "3way", matchScale: 4 }, scale: 4 },
  { name: "sgbm/hh   s=4", params: { algorithm: "sgbm", mode: "hh", matchScale: 4 }, scale: 4 },
  { name: "bm        s=2", params: { algorithm: "bm", matchScale: 2 }, scale: 2 },
  { name: "bm        s=4", params: { algorithm: "bm", matchScale: 4 }, scale: 4 },
  { name: "3way s=4 +wls", params: { algorithm: "sgbm", mode: "3way", matchScale: 4, wls: true }, scale: 4 },
  { name: "bm   s=4 +wls", params: { algorithm: "bm", matchScale: 4, wls: true }, scale: 4 },
];

type Row = Candidate & {
  fps: number; frames: number;
  qPos: { validFrac: number; within2: number; median: number };
  qNeg: { validFrac: number; within2: number; median: number };
};
const rows: Row[] = [];

for (const c of candidates) {
  assert.equal(
    A.setStereoParams(stId, { ...WINDOW, ...c.params }), true,
    `retune to ${c.name}`,
  );
  const qPos = await measureQuality(D_POS, c.scale);
  const qNeg = await measureQuality(D_NEG, c.scale);
  const { fps, frames } = await measureFps(D_POS);
  rows.push({ ...c, fps, frames, qPos, qNeg });
  console.log(
    `43-stereo-throughput: ${c.name.padEnd(18)} fps=${fps.toFixed(1).padStart(6)} ` +
      `(${frames}f) | +${D_POS}: ±2px ${(qPos.within2 * 100).toFixed(1)}% valid ${(qPos.validFrac * 100).toFixed(1)}% med ${qPos.median.toFixed(1)} ` +
      `| ${D_NEG}: ±2px ${(qNeg.within2 * 100).toFixed(1)}% valid ${(qNeg.validFrac * 100).toFixed(1)}% med ${qNeg.median.toFixed(1)}`,
  );
}

// --- result table ---------------------------------------------------------------
console.log("\n=== 43-stereo-throughput RESULT TABLE (1440x1080, window -256..+255) ===");
console.log(
  "candidate          |    fps | frames | +200 ±2px | +200 valid | +200 med | -200 ±2px | -200 valid | -200 med",
);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(18)} | ${r.fps.toFixed(1).padStart(6)} | ${String(r.frames).padStart(6)} | ` +
      `${(r.qPos.within2 * 100).toFixed(1).padStart(8)}% | ${(r.qPos.validFrac * 100).toFixed(1).padStart(9)}% | ${r.qPos.median.toFixed(1).padStart(8)} | ` +
      `${(r.qNeg.within2 * 100).toFixed(1).padStart(8)}% | ${(r.qNeg.validFrac * 100).toFixed(1).padStart(9)}% | ${r.qNeg.median.toFixed(1).padStart(8)}`,
  );
}
console.log("");

// --- assertions ------------------------------------------------------------------
// SIGN CONVENTION: every candidate must recover the
// injected sign on both planes — a contradiction implicates an OPEN
// H-vs-inverse homography-orientation question (flag, do not fix here).
for (const r of rows) {
  assert(
    r.qPos.median > 0 && Math.abs(r.qPos.median - D_POS) <= 4,
    `${r.name}: POSITIVE plane sign+magnitude (median ${r.qPos.median.toFixed(1)} vs +${D_POS}) — ` +
      `a sign contradiction implicates stage-f "H-vs-inverse" (report, don't fix)`,
  );
  assert(
    r.qNeg.median < 0 && Math.abs(r.qNeg.median - D_NEG) <= 4,
    `${r.name}: NEGATIVE plane sign+magnitude (median ${r.qNeg.median.toFixed(1)} vs ${D_NEG})`,
  );
}
console.log("43-stereo-throughput: SIGNED window recovers both signs (convention pinned).");

// SELECTION GATE: the candidate baked into StereoParams' DEFAULTS (sgbm/3way
// s=4) must meet the ≥55 fps floor + the quality bar on this camera-res bench.
const chosen = rows.find((r) => r.name === "sgbm/3way s=4")!;
const chosenQuality = Math.min(chosen.qPos.within2, chosen.qNeg.within2);
assert(
  chosen.fps >= FPS_FLOOR,
  `default candidate meets the ${FPS_FLOOR} fps floor (got ${chosen.fps.toFixed(1)})`,
);
assert(
  chosenQuality >= QUALITY_BAR,
  `default candidate meets the quality bar (worst-sign ±2px ${(chosenQuality * 100).toFixed(1)}% >= ${QUALITY_BAR * 100}%)`,
);
console.log(
  `43-stereo-throughput: DEFAULT (sgbm/3way s=4) ${chosen.fps.toFixed(1)} fps, worst-sign ±2px ${(chosenQuality * 100).toFixed(1)}% — gate met.`,
);

// DIMS AT MATCH SCALE: the scaled candidates already asserted map width == W/s
// per frame inside measureQuality (advert carries actual dims).

// --- teardown ---------------------------------------------------------------------
reader.close(rh);
P.disconnect(stId);
assert.equal(A.detachStereoPipe(stId), true, "detach stereo");
P.close(stId); P.drop(stId);
assert.equal(A.releasePairTestSource(L), true, "release L source");
assert.equal(A.releasePairTestSource(R), true, "release R source");
await sleep(100);
console.log("43-stereo-throughput: bench + signed-range + retune surface passed.");
