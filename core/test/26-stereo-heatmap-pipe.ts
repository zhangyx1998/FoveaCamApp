// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Stereo SGBM + heatmap bricks (stereo-disparity-and-heatmap-nodes): the FIRST
// two-input chained brick (cv::StereoSGBM → CV_32F disparity pipe) + the
// colormap brick (F32/U8 1-channel → RGBA8 TURBO). NO hardware (fake camera).
//
// The stereo pair is SYNTHESIZED with two slice (fovea) crops of the SAME
// convert source, offset horizontally by D px: a feature at source x appears at
// xL = x − X0 in the left crop and xR = x − (X0 + D) in the right crop, so the
// ground-truth disparity (xL − xR) is exactly D everywhere. (The fake camera's
// moving pattern gives block matching texture; L/R may pair frames one tick
// apart — latest-wins — so the value assertion is deliberately loose.)
//
// Proves:
//   1. ATTACH GUARDS — unknown target pipe / unknown source pipe / bad params
//      throw with named errors.
//   2. ON-DEMAND — with NO consumer anywhere, the stereo brick stays
//      PARKED (zero produced frames). Connecting the HEATMAP pipe (the only
//      consumer, two bricks downstream) wakes the WHOLE chain — heatmap tap →
//      stereo → two slice taps → convert → camera; disconnecting parks it again.
//   3. HEATMAP OUTPUT — RGBA8 at the disparity's active dims, alpha 255.
//   4. DISPARITY VALUES — reading the F32 pipe directly: ≥5% valid pixels and
//      a per-frame median within [D/2, 3D/2] (SGBM is approximate; the pair
//      may be one frame skewed).
//   5. REACTIVE PARAMS — setStereoParams/setHeatmapParams apply live (frames
//      keep flowing); unknown pipe → false; invalid params throw.
//   6. DETACH idempotency + orderly reverse teardown → natural exit 0.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/26-stereo-heatmap-pipe.ts

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
const D = 24; // injected horizontal shift = ground-truth disparity (px)
// Slice crops of the same source, right offset by +D → disparity ≈ D.
const SW = Math.min(256, W - 96 - D);
const SH = Math.min(192, H - 96);
assert(SW >= 128 && SH >= 96, `fake camera too small for the crops (${W}x${H})`);
const RL = { x: 64, y: 48, width: SW, height: SH };
const RR = { x: 64 + D, y: 48, width: SW, height: SH };

const rawId = `camera/${serial}/convert`;
const slcLId = `camera/${serial}/convert/slice/stereo-l`;
const slcRId = `camera/${serial}/convert/slice/stereo-r`;
const stId = `stereo/test`;
const hmId = `${stId}/heatmap/view`;

const fullBytes = W * H * CH;
P.advertise({ id: rawId, pixelFormat: "RGBA8", dtype: "U8", width: W, height: H, channels: CH, stride: W * CH, bytesPerFrame: fullBytes, ringDepth: 4 });
const advertiseSlice = (id: string, r: { width: number; height: number }) =>
  P.advertise({ id, pixelFormat: "RGBA8", dtype: "U8", width: r.width, height: r.height, channels: CH, stride: r.width * CH, bytesPerFrame: r.width * r.height * CH, ringDepth: 4, maxWidth: SW, maxHeight: SH, maxBytes: SW * SH * CH });
advertiseSlice(slcLId, RL);
advertiseSlice(slcRId, RR);
// F32 disparity pipe (4 bytes/px, 1 channel) + RGBA8 heatmap, both slice-sized.
const f32Bytes = SW * SH * 4;
P.advertise({ id: stId, pixelFormat: "Disparity32F", dtype: "F32", width: SW, height: SH, channels: 1, stride: SW * 4, bytesPerFrame: f32Bytes, ringDepth: 4, maxWidth: SW, maxHeight: SH, maxBytes: f32Bytes });
P.advertise({ id: hmId, pixelFormat: "RGBA8", dtype: "U8", width: SW, height: SH, channels: CH, stride: SW * CH, bytesPerFrame: SW * SH * CH, ringDepth: 4, maxWidth: SW, maxHeight: SH, maxBytes: SW * SH * CH });

assert.equal(A.attachCameraPipe(camera, rawId), true, "converter attaches");
assert.equal(A.attachFoveaPipe(rawId, slcLId, { rect: RL }), true, "left slice attaches");
assert.equal(A.attachFoveaPipe(rawId, slcRId, { rect: RR }), true, "right slice attaches");

// --- 1: attach guards --------------------------------------------------------
assert.throws(() => A.attachStereoPipe(slcLId, slcRId, "stereo/none", {}), /unknown pipe/, "unknown target pipe throws");
assert.throws(() => A.attachStereoPipe("camera/none/convert", slcRId, stId, {}), /LEFT/, "unknown LEFT source throws (named)");
assert.throws(() => A.attachStereoPipe(slcLId, "camera/none/convert", stId, {}), /RIGHT/, "unknown RIGHT source throws (named)");
assert.throws(() => A.attachStereoPipe(slcLId, slcRId, stId, { numDisparities: 0 }), /numDisparities/, "bad numDisparities throws");
assert.throws(() => A.attachHeatmapPipe(stId, "stereo/none/heatmap/x", {}), /unknown pipe/, "heatmap unknown target throws");

// matchScale 1: this test pins the FULL-RES legacy behavior (dims == slice
// dims, values directly comparable) — the brick DEFAULT is the scaled bench
// winner (stereo-throughput.md), so the scale is pinned explicitly here.
// numDisparities 64: unambiguous within the fake pattern's period, and the
// invalidated left margin stays a minority of the crop.
assert.equal(A.attachStereoPipe(slcLId, slcRId, stId, { numDisparities: 64, matchScale: 1 }), true, "stereo attaches on the two slices");
assert.equal(A.attachHeatmapPipe(stId, hmId, {}), true, "heatmap attaches on the stereo pipe (findStereo)");

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
  const p = A.stereoProbeAll()[stId];
  assert.equal(p.name, stId, "stereo meter name == pipeId (node id)");
  assert.equal(p.outputs.disparity.count, 0, "stereo brick PARKED before any consumer (no subscriber → no compute)");
}

// --- 2b + 3: connecting the HEATMAP pipe wakes the whole chain ----------------
const hm = open(hmId, SW * SH * CH);
{
  let ok = 0;
  const deadline = Date.now() + 15_000;
  while (ok < 3 && Date.now() < deadline) {
    const r = pull(hm);
    if (r) {
      assert.equal(r.width, SW, "heatmap active width = disparity width");
      assert.equal(r.height, SH, "heatmap active height");
      const px = new Uint8Array(hm.dest, 0, SW * SH * CH);
      assert.equal(px[3], 255, "RGBA alpha = 255");
      ok++;
    } else await sleep(5);
  }
  assert(ok >= 3, `heatmap frames flowed (${ok}) — demand propagated heatmap → stereo → slices → convert`);
  const p = A.stereoProbeAll()[stId];
  assert(p.outputs.disparity.count >= 3, "stereo brick WOKE on the heatmap consumer (two bricks downstream)");
  assert(p.inputs.left.count >= 3 && p.inputs.right.count >= 1, "both stereo inputs metered");
  const hp = A.heatmapProbeAll()[hmId];
  assert(hp.outputs.heatmap ? hp.outputs.heatmap.count >= 3 : Object.values(hp.outputs).some((o: any) => o.count >= 3), "heatmap outputs metered");
  console.log("26-stereo-heatmap: on-demand wake through the 2-brick chain + RGBA8 heatmap OK.");
}

// --- 2c: disconnecting parks the chain again ----------------------------------
reader.close(hm.rh); P.disconnect(hmId);
await sleep(300); // let the in-flight tick drain
const parkedCount = A.stereoProbeAll()[stId].outputs.disparity.count as number;
await sleep(500);
{
  const again = A.stereoProbeAll()[stId].outputs.disparity.count as number;
  assert(again - parkedCount <= 1, `stereo brick parked after the heatmap consumer left (Δ=${again - parkedCount})`);
  console.log("26-stereo-heatmap: park on disconnect OK.");
}

// --- 4: disparity values (F32 pipe read directly) -----------------------------
const st = open(stId, f32Bytes);
{
  const medians: number[] = [];
  const deadline = Date.now() + 15_000;
  while (medians.length < 3 && Date.now() < deadline) {
    const r = pull(st);
    if (!r) { await sleep(5); continue; }
    assert.equal(r.width, SW, "disparity active width");
    assert.equal(r.height, SH, "disparity active height");
    assert.equal(r.originX, RL.x, "origin forwarded from the LEFT slice");
    assert.equal(r.originY, RL.y, "origin.y forwarded from the LEFT slice");
    const d = new Float32Array(st.dest, 0, SW * SH);
    // SGBM invalid = minDisparity − 1 (−1 here); ignore the invalidated left
    // margin + unmatched pixels.
    const valid: number[] = [];
    for (let i = 0; i < d.length; i++) if (d[i] >= 0 && Number.isFinite(d[i])) valid.push(d[i]);
    if (valid.length < 0.05 * d.length) { await sleep(5); continue; } // warmup frame
    valid.sort((a, b) => a - b);
    medians.push(valid[Math.floor(valid.length / 2)]);
  }
  assert(medians.length >= 3, `disparity frames with ≥5% valid pixels (${medians.length})`);
  medians.sort((a, b) => a - b);
  const med = medians[Math.floor(medians.length / 2)];
  assert(med >= D * 0.5 && med <= D * 1.5, `median disparity ${med.toFixed(1)} within ±50% of the injected ${D}px shift`);
  console.log(`26-stereo-heatmap: F32 disparity plausible (median ${med.toFixed(1)}px vs injected ${D}px).`);
}

// --- 5: reactive params --------------------------------------------------------
{
  assert.equal(A.setStereoParams("stereo/none", { blockSize: 7 }), false, "unknown stereo pipe → false");
  assert.throws(() => A.setStereoParams(stId, { numDisparities: -4 }), /numDisparities/, "invalid retune throws");
  assert.equal(A.setStereoParams(stId, { numDisparities: 32, blockSize: 7, matchScale: 1 }), true, "stereo retune accepted");
  assert.equal(A.setHeatmapParams("stereo/none/heatmap/x", { min: 0 }), false, "unknown heatmap pipe → false");
  assert.equal(A.setHeatmapParams(hmId, { min: 0, max: 64 }), true, "heatmap retune accepted");
  let ok = 0;
  const deadline = Date.now() + 10_000;
  while (ok < 2 && Date.now() < deadline) {
    const r = pull(st);
    if (r) ok++;
    else await sleep(5);
  }
  assert(ok >= 2, `frames keep flowing after live retunes (${ok})`);
  console.log("26-stereo-heatmap: reactive setStereoParams/setHeatmapParams OK.");
}

// --- 6: detach idempotency + orderly reverse teardown --------------------------
reader.close(st.rh); P.disconnect(stId);
assert.equal(A.detachHeatmapPipe(hmId), true, "detach heatmap");
assert.equal(A.detachHeatmapPipe(hmId), false, "heatmap detach idempotent");
assert.equal(A.heatmapProbeAll()[hmId], undefined, "heatmap gone from the registry");
P.close(hmId); P.drop(hmId);
assert.equal(A.detachStereoPipe(stId), true, "detach stereo");
assert.equal(A.detachStereoPipe(stId), false, "stereo detach idempotent");
assert.equal(A.stereoProbeAll()[stId], undefined, "stereo gone from the registry");
P.close(stId); P.drop(stId);
assert.equal(A.detachFoveaPipe(slcLId), true, "detach left slice");
assert.equal(A.detachFoveaPipe(slcRId), true, "detach right slice");
A.detachCameraPipe(rawId);
for (const id of [rawId, slcLId, slcRId]) { P.close(id); P.drop(id); }
camera.release();

console.log("26-stereo-heatmap: orderly teardown complete — exiting naturally.");
