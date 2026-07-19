// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The in-process brick
// chain — converter → (Leaky<OwnedFrame> tap) → undistort v2 HOMOGRAPHY →
// (tap) → fovea. NO hardware (fake camera). Proves:
//   0. ParamRing lookup semantics — the native self-test (exact hit, linear
//      interpolation, before-oldest/after-newest clamps, empty-ring miss,
//      capacity wrap) runs wholly in C++.
//   1. DEMAND PROPAGATION ACROSS TRANSPORTS — with ZERO consumers on the
//      convert pipe, connecting the undistort pipe alone makes frames flow:
//      the undistort brick's tap subscription wakes the converter
//      (converterProbeAll shows it converting).
//   2. UNCALIBRATED PASSTHROUGH — homography variant with an EMPTY mirror
//      ring passes frames through byte-exact (matched on deviceTimestamp vs
//      the convert pipe), probe marks {variant:"homography",
//      calibratedClock:false, passthrough>0}.
//   3. IDENTITY H — pushHomography with I3 keeps byte-exact passthrough
//      (warpPerspective at integer coords is exact), passthrough counter
//      stops growing (the ring now answers).
//   4. TRANSLATION H — pushing H=[[1,0,tx],[0,1,0],[0,0,1]] (newest entry ≤
//      every frame's hostNs) displaces pixels exactly: dst(x,y)=src(x−tx,y).
//   5. CONTROL-SURFACE GUARDS — pushHomography rejects unknown pipes;
//      setClockOffset is the documented deprecated NO-OP (owner-applied
//      timestamps: the camera stamps its dt at Frame creation, so
//      calibratedClock reflects the CAMERA's — here uncalibrated — state).
//   6. CHAIN DEPTH 3 — a fovea chained on the undistort brick crops the
//      WARPED frames byte-exact (OwnedFrame handoff twice removed from the
//      camera).
//   7. ORDERLY teardown → natural exit 0, zero leak warns.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/22-brick-chain.ts

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, __origin__ } from "core";

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(join(dirname(__origin__), `${prefix}-shm-reader.node`)) as {
  open(seg: string): object;
  readInto(h: object, dest: ArrayBuffer, lastSeq: bigint):
    | { seq: bigint; width: number; height: number; meta: { deviceTimestamp: bigint }; closed?: undefined }
    | { closed: true }
    | null;
  close(h: object): void;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = Pipe as any, A = Aravis as any;

// --- 0: ParamRing lookup semantics (native self-test) ------------------------
assert.equal(A.__paramRingSelfTest(), true, "ParamRing self-test");
console.log("22-brick-chain: ParamRing native self-test OK.");

A.enableFakeCamera();
const camera = (await A.Camera.list())[0];
const probe0 = await camera.grab(2_000_000);
const [H, W] = probe0.raw.shape as [number, number];
probe0.release?.();
const serial = String(camera.serial ?? "0");

const CH = 4; // BGRA8
const bytes = W * H * CH;
const advertise = (id: string) =>
  P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width: W, height: H, channels: CH, stride: W * CH, bytesPerFrame: bytes, ringDepth: 4 });

const cnvId = `camera/${serial}/convert`;
const wrpId = `camera/${serial}/undistort`; // homography variant
advertise(cnvId); advertise(wrpId);
assert.equal(A.attachCameraPipe(camera, cnvId), true, "converter attaches");
assert.equal(A.attachUndistortPipe(cnvId, wrpId, { homography: true, ringCapacity: 64 }), true, "homography undistort attaches (chained on convert)");
// Chained attach rejects a pipe with no brick.
assert.throws(() => A.attachUndistortPipe("camera/none/convert", wrpId, { homography: true }), /no converter/, "unknown source pipe throws");

type Src = { rh: object; dest: ArrayBuffer; lastSeq: bigint };
const open = (id: string, nBytes = bytes): Src => ({ rh: reader.open(P.connect(id).shmName), dest: new ArrayBuffer(nBytes), lastSeq: 0n });
const pull = (s: Src) => {
  const r = reader.readInto(s.rh, s.dest, s.lastSeq);
  if (!r || (r as any).closed) return null;
  s.lastSeq = (r as any).seq;
  return r as { seq: bigint; width: number; height: number; meta: { deviceTimestamp: bigint } };
};

// --- 1: demand propagation — undistort demanded, convert pipe consumer-less --
const wrp = open(wrpId);
{
  let got = 0;
  const deadline = Date.now() + 8000;
  while (got < 3 && Date.now() < deadline) {
    if (pull(wrp)) got++;
    else await sleep(3);
  }
  assert(got >= 3, `undistort pipe flows with zero convert-pipe consumers (${got})`);
  assert.equal(P.consumers(cnvId), 0, "convert pipe really has no SHM consumers");
  const cp = A.converterProbeAll()[cnvId];
  assert(cp && cp.outputs.converted.count >= 3, `converter ran on tap demand alone (${cp?.outputs?.converted?.count})`);
  const up = A.undistortProbeAll()[wrpId];
  assert.equal(up.variant, "homography", "probe variant");
  assert.equal(up.calibratedClock, false, "probe calibratedClock false (fake camera is uncalibrated)");
  assert(up.passthrough >= 3, `empty ring passes through (${up.passthrough})`);
  console.log(`22-brick-chain: demand propagation OK (undistort ${got} frames, converter ${cp.outputs.converted.count} converts, ${up.passthrough} passthroughs).`);
}

// --- 2/3/4: passthrough → identity H → translation H -------------------------
const cnv = open(cnvId);
const cnvByTs = new Map<string, Uint8Array>();
// Collect matched (undistort, convert) frame pairs; verify() judges each pair.
async function verifyMatched(n: number, verify: (got: Uint8Array, ref: Uint8Array) => void, label: string) {
  let ok = 0;
  const deadline = Date.now() + 10_000;
  while (ok < n && Date.now() < deadline) {
    let idle = true;
    const rc = pull(cnv);
    if (rc) { cnvByTs.set(String(rc.meta.deviceTimestamp), new Uint8Array(cnv.dest.slice(0))); idle = false; }
    if (cnvByTs.size > 32) cnvByTs.delete(cnvByTs.keys().next().value!);
    const rw = pull(wrp);
    if (rw) {
      idle = false;
      const ref = cnvByTs.get(String(rw.meta.deviceTimestamp));
      if (ref) { verify(new Uint8Array(wrp.dest.slice(0)), ref); ok++; }
    }
    if (idle) await sleep(3);
  }
  assert(ok >= n, `${label}: matched ${ok}/${n} frames`);
  return ok;
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// 2: empty ring — byte-exact passthrough.
await verifyMatched(3, (got, ref) => assert(bytesEqual(got, ref), "uncalibrated passthrough is byte-exact"), "passthrough");
console.log("22-brick-chain: uncalibrated passthrough byte-exact OK.");

// 3: identity H at hostNs=0 (every frame's hostNs ≥ 0 → nearest ≤ is I3).
const I3 = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
assert.equal(A.pushHomography(wrpId, 0n, I3), true, "pushHomography identity");
const passBefore = A.undistortProbeAll()[wrpId].passthrough as number;
await sleep(100); // drain frames produced before the push
await verifyMatched(3, () => {}, "warm-up post-push");
await verifyMatched(3, (got, ref) => assert(bytesEqual(got, ref), "identity H warps to byte-exact equality"), "identity-H");
assert.equal(A.undistortProbeAll()[wrpId].passthrough, passBefore, "passthrough counter stopped growing (ring answers)");
console.log("22-brick-chain: identity-H warp byte-exact OK.");

// 4: translation H (newest entry) — dst(x,y) = src(x−tx, y) exactly.
const TX = 32;
const T3 = new Float64Array([1, 0, TX, 0, 1, 0, 0, 0, 1]);
assert.equal(A.pushHomography(wrpId, 1n, T3), true, "pushHomography translation");
await verifyMatched(3, () => {}, "warm-up post-translation");
await verifyMatched(3, (got, ref) => {
  // Sample interior pixels on a coarse grid (B channel; BGRA stride 4).
  for (let y = 8; y < H - 8; y += Math.max(8, H >> 4)) {
    for (let x = TX + 8; x < W - 8; x += Math.max(8, W >> 4)) {
      const gi = (y * W + x) * CH;
      const ri = (y * W + (x - TX)) * CH;
      assert.equal(got[gi], ref[ri], `translated pixel (${x},${y})`);
    }
  }
}, "translation-H");
console.log(`22-brick-chain: translation-H displaces exactly ${TX}px OK.`);

// --- 5: control-surface guards (owner-applied timestamps) ---------------------
assert.equal(A.setClockOffset(wrpId, 0n), 0, "setClockOffset is a deprecated no-op (returns 0)");
assert.equal(A.undistortProbeAll()[wrpId].calibratedClock, false, "calibratedClock mirrors the CAMERA state (uncalibrated fake)");
assert.equal(A.pushHomography("camera/none/undistort", 0n, I3), false, "pushHomography unknown pipe -> false");
console.log("22-brick-chain: control-surface guards OK (owner-applied dt).");

// --- 6: chain depth 3 — fovea crops the WARPED output byte-exact --------------
const fovId = `camera/${serial}/undistort/fovea/0`;
const R0 = { x: 96, y: 64, width: 128, height: 96 };
P.advertise({ id: fovId, pixelFormat: "BGRA8", dtype: "U8", width: R0.width, height: R0.height, channels: CH, stride: R0.width * CH, bytesPerFrame: R0.width * R0.height * CH, ringDepth: 4 });
assert.equal(A.attachFoveaPipe(wrpId, fovId, { rect: R0 }), true, "fovea attaches on the homography brick");
const fov = open(fovId, R0.width * R0.height * CH);
{
  const wrpByTs = new Map<string, Uint8Array>();
  let ok = 0;
  const deadline = Date.now() + 10_000;
  while (ok < 3 && Date.now() < deadline) {
    let idle = true;
    const rw = pull(wrp);
    if (rw) { wrpByTs.set(String(rw.meta.deviceTimestamp), new Uint8Array(wrp.dest.slice(0))); idle = false; }
    if (wrpByTs.size > 32) wrpByTs.delete(wrpByTs.keys().next().value!);
    const rf = pull(fov);
    if (rf) {
      idle = false;
      const ref = wrpByTs.get(String(rf.meta.deviceTimestamp));
      if (ref) {
        const got = new Uint8Array(rf.width * rf.height * CH);
        got.set(new Uint8Array(fov.dest, 0, got.length));
        const want = new Uint8Array(R0.width * R0.height * CH);
        for (let row = 0; row < R0.height; row++)
          want.set(ref.subarray(((R0.y + row) * W + R0.x) * CH, ((R0.y + row) * W + R0.x + R0.width) * CH), row * R0.width * CH);
        assert(bytesEqual(got, want), "fovea == warped-frame subrect (depth-3 chain)");
        ok++;
      }
    }
    if (idle) await sleep(3);
  }
  assert(ok >= 3, `depth-3 chain identity matched frames (${ok})`);
  assert.equal(A.foveaProbeAll()[fovId].undistorted, true, "fovea marks undistorted space");
  console.log("22-brick-chain: depth-3 chain (convert→undistort→fovea) byte-exact OK.");
}

// Detach the Leaky fovea before the FIFO section to isolate the convert→
// undistort edge (the fovea chain behaviour was already asserted byte-exact
// above — that IS the "Leaky chain still behaves" check).
reader.close(fov.rh); P.disconnect(fovId);
assert.equal(A.detachFoveaPipe(fovId), true, "detach fovea");
P.close(fovId); P.drop(fovId);

// --- 8: FIFO backpressure — every converted frame reaches undistort IN ORDER --
// The convert→undistort edge is a bounded blocking FIFO: slow the
// undistort consumer past the camera frame interval so its input queue backs
// up. The FIFO must never skip (undistort drops stay 0, deviceTimestamps
// strictly increase), the queue high-water must climb above 1, and the
// converter must shed the overload at its OWN latest-wins camera input.
{
  const convBefore = A.converterProbeAll()[cnvId].outputs.converted.count as number;
  assert.equal(A.undistortStall(wrpId, 80), true, "stall the undistort consumer"); // > ~42ms cam interval
  let last = -1n;
  let frames = 0;
  const deadline = Date.now() + 6000;
  while (frames < 20 && Date.now() < deadline) {
    const rw = pull(wrp);
    if (rw) {
      const ts = rw.meta.deviceTimestamp;
      assert(ts > last, `undistort output strictly ordered (${last} -> ${ts})`);
      last = ts;
      frames++;
    } else {
      await sleep(5);
    }
  }
  assert(frames >= 10, `undistort kept producing under backpressure (${frames})`);
  const up = A.undistortProbeAll()[wrpId];
  assert(up.queue, "undistort probe carries a queue block (FIFO input)");
  assert.equal(up.queue.capacity, 8, "queue capacity is the ruled 8");
  assert(up.queue.highWater > 1, `queue backed up under the stall (highWater=${up.queue.highWater})`);
  assert.equal(up.dropTotal, 0, `undistort NEVER skips a frame (drops=${up.dropTotal})`);
  // The overload sheds at camera→convert (converter's latest-wins input),
  // metered as converter drops — convert→undistort stays complete.
  const cp = A.converterProbeAll()[cnvId];
  assert(cp.dropTotal > 0, `overload shed at the camera→convert edge (converter drops=${cp.dropTotal})`);

  // Release the stall and let the FIFO drain: undistort ingests EVERY converted
  // frame (lossless) — its input count catches up to the converter's output to
  // within the FIFO's in-flight depth, still with zero drops.
  assert.equal(A.undistortStall(wrpId, 0), true, "release the stall");
  const drainEnd = Date.now() + 3000;
  while (Date.now() < drainEnd) { if (!pull(wrp)) await sleep(5); }
  const conv = A.converterProbeAll()[cnvId].outputs.converted.count as number;
  const undIn = A.undistortProbeAll()[wrpId].inputs.frame.count as number;
  assert(conv > convBefore, "converter kept producing across the test");
  assert(undIn <= conv && conv - undIn <= 10,
    `undistort ingested every converted frame within FIFO depth (converted=${conv}, undistort=${undIn})`);
  assert.equal(A.undistortProbeAll()[wrpId].dropTotal, 0, "still zero undistort drops after drain");
  console.log(`22-brick-chain: FIFO backpressure OK (highWater=${up.queue.highWater}/cap ${up.queue.capacity}, undistort drops 0, converter shed ${cp.dropTotal}, complete convert=${conv}/undistort=${undIn}).`);
}

// --- 7: orderly teardown → natural exit -----------------------
reader.close(wrp.rh); P.disconnect(wrpId);
assert.equal(A.detachUndistortPipe(wrpId), true, "detach undistort");
P.close(wrpId); P.drop(wrpId);
reader.close(cnv.rh); P.disconnect(cnvId);
A.detachCameraPipe(cnvId);
P.close(cnvId); P.drop(cnvId);
camera.release();

console.log("22-brick-chain: orderly teardown complete — exiting naturally.");
