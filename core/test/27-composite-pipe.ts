// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Composite (anaglyph / L-vs-R difference) brick: a two-input RGBA op modelled
// on StereoStream. NO hardware (fake camera).
//
// The stereo pair is SYNTHESIZED with two slice (fovea) crops of the SAME
// convert source — the LEFT crop at RL, the RIGHT crop at RR. With ZERO offset
// (RL == RR) both crops carry the identical pixels, so the difference output is
// exactly zero on the color planes (alpha stays 255). With a horizontal offset
// the anaglyph output's R plane must equal the LEFT crop's R plane and the G/B
// planes the RIGHT crop's (red = LEFT eye, cyan = RIGHT eye).
//
// Proves:
//   1. ATTACH GUARDS — unknown target / unknown source / bad mode throw named.
//   2. PARKED before a consumer — connecting the composite pipe
//      wakes the whole chain (composite → two slice taps → convert → camera);
//      both input ports metered; output RGBA8 with alpha 255.
//   3. ANAGLYPH channel identity — output R == LEFT crop R, G/B == RIGHT crop.
//   4. DIFFERENCE sanity — zero-offset crops ⇒ color planes all zero.
//   5. REACTIVE mode retune — setCompositeParams applies live; invalid mode
//      throws; unknown pipe → false.
//   6. PARK on disconnect; detach idempotency + orderly teardown → natural exit.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/27-composite-pipe.ts

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, __origin__ } from "core";

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(join(dirname(__origin__), `${prefix}-shm-reader.node`)) as {
  open(seg: string): object;
  readInto(h: object, dest: ArrayBuffer, lastSeq: bigint):
    | { seq: bigint; width: number; height: number; originX: number; originY: number; meta: { deviceTimestamp: bigint }; closed?: undefined }
    | { closed: true }
    | null;
  close(h: object): void;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = Pipe as any, A = Aravis as any;

A.enableFakeCamera();
const camera = (await A.Camera.list())[0];
const probe0 = await camera.grab(2_000_000);
const [H, W] = probe0.raw.shape as [number, number];
probe0.release?.();
const serial = String(camera.serial ?? "0");

const CH = 4; // RGBA8
const D = 24; // horizontal shift for the anaglyph identity crops
const SW = Math.min(256, W - 96 - D);
const SH = Math.min(192, H - 96);
assert(SW >= 128 && SH >= 96, `fake camera too small for the crops (${W}x${H})`);
// Left/right crops. For anaglyph identity + difference sanity we want the SAME
// pixels in both when zero-offset; a distinct RIGHT crop (offset D) proves the
// per-channel routing. We advertise both a ZERO-offset and a D-offset right
// slice so one attach can prove difference==0 and another anaglyph identity.
const RL = { x: 64, y: 48, width: SW, height: SH };
const RR0 = { x: 64, y: 48, width: SW, height: SH };       // zero offset (== RL)
const RRD = { x: 64 + D, y: 48, width: SW, height: SH };   // shifted right crop

const rawId = `camera/${serial}/convert`;
const slcLId = `camera/${serial}/convert/slice/comp-l`;
const slcR0Id = `camera/${serial}/convert/slice/comp-r0`;
const slcRDId = `camera/${serial}/convert/slice/comp-rd`;
const cmpDiffId = `stereo/composite-diff`; // zero-offset pair → difference == 0
const cmpAnaId = `stereo/composite-ana`;   // shifted pair → anaglyph identity

const fullBytes = W * H * CH;
P.advertise({ id: rawId, pixelFormat: "RGBA8", dtype: "U8", width: W, height: H, channels: CH, stride: W * CH, bytesPerFrame: fullBytes, ringDepth: 4 });
const advertiseSlice = (id: string, r: { width: number; height: number }) =>
  P.advertise({ id, pixelFormat: "RGBA8", dtype: "U8", width: r.width, height: r.height, channels: CH, stride: r.width * CH, bytesPerFrame: r.width * r.height * CH, ringDepth: 4, maxWidth: SW, maxHeight: SH, maxBytes: SW * SH * CH });
advertiseSlice(slcLId, RL);
advertiseSlice(slcR0Id, RR0);
advertiseSlice(slcRDId, RRD);
const bgraOut = (id: string) =>
  P.advertise({ id, pixelFormat: "RGBA8", dtype: "U8", width: SW, height: SH, channels: CH, stride: SW * CH, bytesPerFrame: SW * SH * CH, ringDepth: 4, maxWidth: SW, maxHeight: SH, maxBytes: SW * SH * CH });
bgraOut(cmpDiffId);
bgraOut(cmpAnaId);

assert.equal(A.attachCameraPipe(camera, rawId), true, "converter attaches");
assert.equal(A.attachFoveaPipe(rawId, slcLId, { rect: RL }), true, "left slice attaches");
assert.equal(A.attachFoveaPipe(rawId, slcR0Id, { rect: RR0 }), true, "zero-offset right slice attaches");
assert.equal(A.attachFoveaPipe(rawId, slcRDId, { rect: RRD }), true, "shifted right slice attaches");

// --- 1: attach guards --------------------------------------------------------
assert.throws(() => A.attachCompositePipe(slcLId, slcR0Id, "stereo/none", { mode: "difference" }), /unknown pipe/, "unknown target pipe throws");
assert.throws(() => A.attachCompositePipe("camera/none/convert", slcR0Id, cmpDiffId, { mode: "difference" }), /LEFT/, "unknown LEFT source throws (named)");
assert.throws(() => A.attachCompositePipe(slcLId, "camera/none/convert", cmpDiffId, { mode: "difference" }), /RIGHT/, "unknown RIGHT source throws (named)");
assert.throws(() => A.attachCompositePipe(slcLId, slcR0Id, cmpDiffId, { mode: "bogus" }), /mode/, "bad mode throws");
assert.throws(() => A.attachCompositePipe(slcLId, slcR0Id, cmpDiffId, { mode: "anaglyph", style: "XX" }), /style/, "bad anaglyph style throws (named)");

assert.equal(A.attachCompositePipe(slcLId, slcR0Id, cmpDiffId, { mode: "difference" }), true, "difference composite attaches (zero-offset pair)");
assert.equal(A.attachCompositePipe(slcLId, slcRDId, cmpAnaId, { mode: "anaglyph" }), true, "anaglyph composite attaches (shifted pair)");

type Src = { rh: object; dest: ArrayBuffer; lastSeq: bigint };
const open = (id: string, bytes: number): Src => ({ rh: reader.open(P.connect(id).shmName), dest: new ArrayBuffer(bytes), lastSeq: 0n });
const pull = (s: Src) => {
  const r = reader.readInto(s.rh, s.dest, s.lastSeq);
  if (!r || (r as any).closed) return null;
  s.lastSeq = (r as any).seq;
  return r as { seq: bigint; width: number; height: number; originX: number; originY: number };
};

// --- 2a: parked with no consumer anywhere ------------------------------------
await sleep(400);
{
  const p = A.compositeProbeAll()[cmpDiffId];
  assert.equal(p.name, cmpDiffId, "composite meter name == pipeId (node id)");
  assert.equal(p.outputs.composite.count, 0, "composite brick PARKED before any consumer (no subscriber → no compute)");
}

// --- 2b + 4: connect the DIFFERENCE pipe; zero-offset ⇒ color planes zero -----
const diff = open(cmpDiffId, SW * SH * CH);
{
  let ok = 0;
  const deadline = Date.now() + 15_000;
  while (ok < 3 && Date.now() < deadline) {
    const r = pull(diff);
    if (r) {
      assert.equal(r.width, SW, "composite active width = LEFT slice width");
      assert.equal(r.height, SH, "composite active height");
      assert.equal(r.originX, RL.x, "origin forwarded from the LEFT slice");
      assert.equal(r.originY, RL.y, "origin.y forwarded from the LEFT slice");
      const px = new Uint8Array(diff.dest, 0, SW * SH * CH);
      // Alpha 255 on every pixel; color planes (B,G,R) all zero (identical crops).
      let maxColor = 0;
      let alphaOk = true;
      for (let i = 0; i < SW * SH; i++) {
        maxColor = Math.max(maxColor, px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
        if (px[i * 4 + 3] !== 255) alphaOk = false;
      }
      assert.equal(alphaOk, true, "RGBA alpha = 255 on every pixel");
      assert.equal(maxColor, 0, `difference of identical crops is zero (max color ${maxColor})`);
      ok++;
    } else await sleep(5);
  }
  assert(ok >= 3, `difference frames flowed (${ok}) — demand propagated composite → slices → convert`);
  const p = A.compositeProbeAll()[cmpDiffId];
  assert(p.outputs.composite.count >= 3, "composite brick WOKE on the consumer");
  assert(p.inputs.left.count >= 3 && p.inputs.right.count >= 1, "both composite inputs metered");
  console.log("27-composite: on-demand wake + zero-offset difference == 0 (alpha 255) OK.");
}

// --- 3: anaglyph channel identity (shifted pair) -----------------------------
// Read the composite output AND both source slices, matching by nothing but
// steady-state pixels: with a static-ish region the identity holds per plane.
const ana = open(cmpAnaId, SW * SH * CH);
const srcL = open(slcLId, SW * SH * CH);
const srcR = open(slcRDId, SW * SH * CH);
{
  let proven = false;
  const deadline = Date.now() + 15_000;
  while (!proven && Date.now() < deadline) {
    const ro = pull(ana);
    if (!ro) { await sleep(5); continue; }
    // Drain the freshest source frames.
    let lr = pull(srcL); for (let g = pull(srcL); g; g = pull(srcL)) lr = g;
    let rr = pull(srcR); for (let g = pull(srcR); g; g = pull(srcR)) rr = g;
    if (!lr || !rr) { await sleep(5); continue; }
    const out = new Uint8Array(ana.dest, 0, SW * SH * CH);
    const L = new Uint8Array(srcL.dest, 0, SW * SH * CH);
    const R = new Uint8Array(srcR.dest, 0, SW * SH * CH);
    // Honest RGBA8: channel 0 = R, 1 = G, 2 = B, 3 = A. Anaglyph: out.R = L.R
    // (channel 0 from LEFT), out.G = R.G, out.B = R.B. The moving fake pattern
    // may skew L/R/out by a frame; count matching pixels and require a majority.
    let rMatch = 0, gMatch = 0, bMatch = 0, alphaOk = 0;
    const n = SW * SH;
    for (let i = 0; i < n; i++) {
      if (out[i * 4 + 0] === L[i * 4 + 0]) rMatch++;   // R (ch0) == LEFT R
      if (out[i * 4 + 1] === R[i * 4 + 1]) gMatch++;   // G (ch1) == RIGHT G
      if (out[i * 4 + 2] === R[i * 4 + 2]) bMatch++;   // B (ch2) == RIGHT B
      if (out[i * 4 + 3] === 255) alphaOk++;
    }
    assert.equal(alphaOk, n, "anaglyph alpha = 255 on every pixel");
    // Require ≥90% plane identity — the residue is frame-skew between the three
    // independently-paced SHM readers, not a routing error.
    if (rMatch >= 0.9 * n && gMatch >= 0.9 * n && bMatch >= 0.9 * n) {
      proven = true;
      console.log(`27-composite: anaglyph channel identity OK (R=${((rMatch / n) * 100).toFixed(1)}% ` +
        `G=${((gMatch / n) * 100).toFixed(1)}% B=${((bMatch / n) * 100).toFixed(1)}%).`);
    }
  }
  assert(proven, "anaglyph R==LEFT, G/B==RIGHT channel identity held on a frame (default style RC)");
}

// --- 3b: BR style swap (live retune) — out.R==RIGHT, out.B==LEFT, out.G==0 ----
// Pins a SECOND row of the style→channel table (docs/schema/anaglyph.ts): BR =
// left-eye BLUE (ch2 ← LEFT), right-eye RED (ch0 ← RIGHT), green forced 0. The
// map is applied live via setCompositeParams — no re-attach — proving the style
// enum retunes like `mode` does.
assert.equal(A.setCompositeParams(cmpAnaId, { mode: "anaglyph", style: "BR" }), true, "retune to BR style accepted");
{
  let proven = false;
  const deadline = Date.now() + 15_000;
  while (!proven && Date.now() < deadline) {
    const ro = pull(ana);
    if (!ro) { await sleep(5); continue; }
    let lr = pull(srcL); for (let g = pull(srcL); g; g = pull(srcL)) lr = g;
    let rr = pull(srcR); for (let g = pull(srcR); g; g = pull(srcR)) rr = g;
    if (!lr || !rr) { await sleep(5); continue; }
    const out = new Uint8Array(ana.dest, 0, SW * SH * CH);
    const L = new Uint8Array(srcL.dest, 0, SW * SH * CH);
    const R = new Uint8Array(srcR.dest, 0, SW * SH * CH);
    let rMatch = 0, gZero = 0, bMatch = 0, alphaOk = 0;
    const n = SW * SH;
    for (let i = 0; i < n; i++) {
      if (out[i * 4 + 0] === R[i * 4 + 0]) rMatch++;   // R (ch0) ← RIGHT red
      if (out[i * 4 + 1] === 0) gZero++;               // G (ch1) forced 0
      if (out[i * 4 + 2] === L[i * 4 + 2]) bMatch++;   // B (ch2) ← LEFT blue
      if (out[i * 4 + 3] === 255) alphaOk++;
    }
    assert.equal(alphaOk, n, "BR anaglyph alpha = 255 on every pixel");
    assert.equal(gZero, n, "BR anaglyph green plane forced 0 on every pixel");
    if (rMatch >= 0.9 * n && bMatch >= 0.9 * n) {
      proven = true;
      console.log(`27-composite: BR style channel identity OK (R=${((rMatch / n) * 100).toFixed(1)}% ` +
        `B=${((bMatch / n) * 100).toFixed(1)}%, G=0).`);
    }
  }
  assert(proven, "BR anaglyph out.R==RIGHT, out.B==LEFT, out.G==0 channel identity held on a frame");
}
reader.close(srcL.rh); P.disconnect(slcLId);
reader.close(srcR.rh); P.disconnect(slcRDId);

// --- 5: reactive mode retune -------------------------------------------------
{
  assert.equal(A.setCompositeParams("stereo/none", { mode: "anaglyph" }), false, "unknown composite pipe → false");
  assert.throws(() => A.setCompositeParams(cmpDiffId, { mode: "bogus" }), /mode/, "invalid retune throws");
  assert.equal(A.setCompositeParams(cmpDiffId, { mode: "anaglyph" }), true, "composite retune accepted");
  let ok = 0;
  const deadline = Date.now() + 10_000;
  while (ok < 2 && Date.now() < deadline) {
    const r = pull(diff);
    if (r) ok++;
    else await sleep(5);
  }
  assert(ok >= 2, `frames keep flowing after the live retune (${ok})`);
  // After the retune to anaglyph on the zero-offset pair, R==L and G/B==R are
  // the SAME pixels, so the output equals the (identical) source — still valid
  // RGBA with alpha 255; just confirm flow (done above).
  console.log("27-composite: reactive setCompositeParams OK.");
}

// --- 2c: park on disconnect --------------------------------------------------
reader.close(ana.rh); P.disconnect(cmpAnaId);
reader.close(diff.rh); P.disconnect(cmpDiffId);
await sleep(300); // let the in-flight tick drain
const parkedCount = A.compositeProbeAll()[cmpDiffId].outputs.composite.count as number;
await sleep(500);
{
  const again = A.compositeProbeAll()[cmpDiffId].outputs.composite.count as number;
  assert(again - parkedCount <= 1, `composite brick parked after the consumer left (Δ=${again - parkedCount})`);
  console.log("27-composite: park on disconnect OK.");
}

// --- 6: detach idempotency + orderly reverse teardown ------------------------
assert.equal(A.detachCompositePipe(cmpAnaId), true, "detach anaglyph composite");
assert.equal(A.detachCompositePipe(cmpAnaId), false, "anaglyph detach idempotent");
assert.equal(A.compositeProbeAll()[cmpAnaId], undefined, "anaglyph gone from the registry");
P.close(cmpAnaId); P.drop(cmpAnaId);
assert.equal(A.detachCompositePipe(cmpDiffId), true, "detach difference composite");
assert.equal(A.detachCompositePipe(cmpDiffId), false, "difference detach idempotent");
assert.equal(A.compositeProbeAll()[cmpDiffId], undefined, "difference gone from the registry");
P.close(cmpDiffId); P.drop(cmpDiffId);
assert.equal(A.detachFoveaPipe(slcLId), true, "detach left slice");
assert.equal(A.detachFoveaPipe(slcR0Id), true, "detach zero-offset right slice");
assert.equal(A.detachFoveaPipe(slcRDId), true, "detach shifted right slice");
A.detachCameraPipe(rawId);
for (const id of [rawId, slcLId, slcR0Id, slcRDId]) { P.close(id); P.drop(id); }
camera.release();

console.log("27-composite: orderly teardown complete — exiting naturally.");
