// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Scale brick (split-disparity-nodes §"Scale node = a NEW native chained
// brick"): spawn/cancel-able RESIZE producer threads chained on any
// convert / undistort / fovea (slice) pipe's owned-frame tap. cv::resize
// (INTER_AREA shrinking / INTER_LINEAR growing), reactive params
// {ratio|dwidth|dheight|dsize}, C-20 dynamic pipe (per-frame active OUT w/h,
// source crop origin forwarded UNSCALED in the v4 slot header). NO hardware
// (fake camera). Proves:
//   1. RATIO=1 IDENTITY — a ratio:1 scale of the convert pipe is byte-exact to
//      the convert frame (cv::resize same-size early-out), matched on
//      deviceTimestamp — proving the resize path + timestamp forwarding.
//   2. DIMS MATH — ratio (half), dsize (explicit), and dwidth (aspect-
//      preserving) each yield the computed ACTIVE out dims (reader slot header).
//   3. ORIGIN FORWARDING — a scale chained on a fovea/SLICE forwards the
//      slice's crop origin UNSCALED (source full-res coords), regardless of the
//      ratio, per frame + in the probe.
//   4. VARIABLE INPUT DIMS — steering the slice rect (setFoveaRect) makes the
//      scale recompute its out dims from the NEW active input dims and forward
//      the NEW origin, no re-attach.
//   5. REACTIVE setScaleParams — a live param swap changes the active out dims
//      on the next frame; unknown pipe -> false; invalid/ambiguous params throw.
//   6. DETACH idempotency + orderly teardown (B-20) → natural exit 0.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/25-scale-pipe.ts

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

const mat = (nums: number[], shape: number[]) =>
  Object.assign(new Float64Array(nums), { shape, channels: 1 });

A.enableFakeCamera();
const camera = (await A.Camera.list())[0];
const probe0 = await camera.grab(2_000_000);
const [H, W] = probe0.raw.shape as [number, number];
probe0.release?.();
const serial = String(camera.serial ?? "0");

// Identity intrinsic calibration (dist=0 ⇒ undistort passes frames through).
const f = W * 0.8, cx = W / 2, cy = H / 2;
const cal = {
  sensor_size: { width: W, height: H },
  camera_matrix: mat([f, 0, cx, 0, f, cy, 0, 0, 1], [3, 3]),
  dist_coeffs: mat([0, 0, 0, 0, 0], [1, 5]),
  rvecs: [], tvecs: [],
};

const CH = 4; // BGRA8
const fullBytes = W * H * CH;
const MAXW = 256, MAXH = 192;                 // slice ring footprint (C-20 max)
const maxBytes = MAXW * MAXH * CH;
const R0 = { x: 64, y: 48, width: 128, height: 96 };   // initial slice crop
const R1 = { x: 200, y: 100, width: 240, height: 160 }; // steered slice crop

const advertiseFull = (id: string) =>
  P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width: W, height: H, channels: CH, stride: W * CH, bytesPerFrame: fullBytes, ringDepth: 4 });
const advertiseSlice = (id: string) =>
  P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width: R0.width, height: R0.height, channels: CH, stride: R0.width * CH, bytesPerFrame: R0.width * R0.height * CH, ringDepth: 4, maxWidth: MAXW, maxHeight: MAXH, maxBytes });
// A scale pipe with a generous max footprint (out dims ride the slot header).
const advertiseScale = (id: string, capW: number, capH: number) =>
  P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width: capW, height: capH, channels: CH, stride: capW * CH, bytesPerFrame: capW * capH * CH, ringDepth: 4, maxWidth: capW, maxHeight: capH, maxBytes: capW * capH * CH });

const rawId = `camera/${serial}/convert`;
const undId = `camera/${serial}/undistort`;
const slcId = `camera/${serial}/undistort/slice/scope`;   // the fovea/slice brick
const scIdId = `${rawId}/scale/id`;      // ratio:1 identity (on convert)
const scHalfId = `${undId}/scale/half`;  // ratio:0.5 (on undistort)
const scDsId = `${undId}/scale/dsize`;   // dsize:{200,150} (on undistort)
const scDwId = `${undId}/scale/dw`;      // dwidth (aspect) (on undistort)
const scFovId = `${slcId}/scale/onslice`; // ratio:0.5 (on the slice — origin fwd)

advertiseFull(rawId); advertiseFull(undId); advertiseSlice(slcId);
advertiseScale(scIdId, W, H);
advertiseScale(scHalfId, W, H);
advertiseScale(scDsId, W, H);
advertiseScale(scDwId, W, H);
advertiseScale(scFovId, MAXW, MAXH);

assert.equal(A.attachCameraPipe(camera, rawId), true, "converter attaches");
assert.equal(A.attachUndistortPipe(rawId, undId, { cal }), true, "undistort attaches (chained on convert)");
assert.equal(A.attachFoveaPipe(undId, slcId, { rect: R0 }), true, "slice (fovea) attaches on undistort");

// Expected dims (C++ lround == JS Math.round for positive halves).
const DW = Math.floor(W / 2);
const expDwH = Math.round(H * DW / W);
const HALF = { w: Math.round(W * 0.5), h: Math.round(H * 0.5) };
const DS = { w: 200, h: 150 };
const FOV0 = { w: Math.round(R0.width * 0.5), h: Math.round(R0.height * 0.5) };
const FOV1 = { w: Math.round(R1.width * 0.5), h: Math.round(R1.height * 0.5) };

// --- attach the scale bricks; assert guards ---------------------------------
assert.equal(A.attachScalePipe(rawId, scIdId, { ratio: 1 }), true, "ratio:1 scale attaches on convert");
assert.equal(A.attachScalePipe(undId, scHalfId, { ratio: 0.5 }), true, "ratio:0.5 scale attaches on undistort");
assert.equal(A.attachScalePipe(undId, scDsId, { dsize: { width: DS.w, height: DS.h } }), true, "dsize scale attaches");
assert.equal(A.attachScalePipe(undId, scDwId, { dwidth: DW }), true, "dwidth scale attaches");
assert.equal(A.attachScalePipe(slcId, scFovId, { ratio: 0.5 }), true, "scale attaches on the slice (fovea source resolved)");
// Guards: unknown pipe, unknown source, invalid/ambiguous params.
assert.throws(() => A.attachScalePipe(undId, "camera/none/scale/x", { ratio: 0.5 }), /unknown pipe/, "unknown target pipe throws");
assert.throws(() => A.attachScalePipe("camera/none/undistort", scDsId, { ratio: 0.5 }), /no convert\/undistort\/fovea\/scale/, "unknown source pipe throws");
assert.throws(() => A.attachScalePipe(undId, scDsId, {}), /EXACTLY one/, "zero params throws");
assert.throws(() => A.attachScalePipe(undId, scDsId, { ratio: 1, dwidth: 10 }), /EXACTLY one/, "ambiguous params throws");
assert.throws(() => A.attachScalePipe(undId, scDsId, { ratio: -1 }), /ratio/, "non-positive ratio throws");

type Src = { rh: object; dest: ArrayBuffer; lastSeq: bigint };
const open = (id: string, bytes: number): Src => ({ rh: reader.open(P.connect(id).shmName), dest: new ArrayBuffer(bytes), lastSeq: 0n });
const pull = (s: Src) => {
  const r = reader.readInto(s.rh, s.dest, s.lastSeq);
  if (!r || (r as any).closed) return null;
  s.lastSeq = (r as any).seq;
  return r as { seq: bigint; width: number; height: number; originX: number; originY: number; meta: { deviceTimestamp: bigint } };
};
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const raw = open(rawId, fullBytes);
const scId = open(scIdId, fullBytes);
const scHalf = open(scHalfId, fullBytes);
const scDs = open(scDsId, fullBytes);
const scDw = open(scDwId, fullBytes);
const scFov = open(scFovId, maxBytes);

// --- 1: ratio:1 identity (byte-exact to the convert frame) + 2: dims math ----
{
  const rawByTs = new Map<string, Uint8Array>();
  let idOk = 0, halfOk = 0, dsOk = 0, dwOk = 0;
  const deadline = Date.now() + 12_000;
  while ((idOk < 3 || halfOk < 3 || dsOk < 3 || dwOk < 3) && Date.now() < deadline) {
    let idle = true;
    let r = pull(raw);
    if (r) { rawByTs.set(String(r.meta.deviceTimestamp), new Uint8Array(raw.dest.slice(0))); idle = false; }
    if (rawByTs.size > 48) rawByTs.delete(rawByTs.keys().next().value!);
    r = pull(scId);
    if (r && idOk < 3) {
      idle = false;
      const ref = rawByTs.get(String(r.meta.deviceTimestamp));
      if (ref) {
        assert.equal(r.width, W, "identity active width = W");
        assert.equal(r.height, H, "identity active height = H");
        const got = new Uint8Array(r.width * r.height * CH);
        got.set(new Uint8Array(scId.dest, 0, got.length));
        assert(bytesEqual(got, ref), "ratio:1 scale == convert frame (byte-exact)");
        idOk++;
      }
    }
    r = pull(scHalf);
    if (r && halfOk < 3) { idle = false; assert.equal(r.width, HALF.w, "ratio:0.5 out width"); assert.equal(r.height, HALF.h, "ratio:0.5 out height"); halfOk++; }
    r = pull(scDs);
    if (r && dsOk < 3) { idle = false; assert.equal(r.width, DS.w, "dsize out width"); assert.equal(r.height, DS.h, "dsize out height"); dsOk++; }
    r = pull(scDw);
    if (r && dwOk < 3) { idle = false; assert.equal(r.width, DW, "dwidth out width = dwidth"); assert.equal(r.height, expDwH, "dwidth out height preserves aspect"); dwOk++; }
    if (idle) await sleep(3);
  }
  assert(idOk >= 3 && halfOk >= 3 && dsOk >= 3 && dwOk >= 3, `dims/identity matched (id=${idOk} half=${halfOk} ds=${dsOk} dw=${dwOk})`);
  console.log(`25-scale-pipe: ratio:1 identity byte-exact + dims math OK (ratio ${HALF.w}x${HALF.h}, dsize ${DS.w}x${DS.h}, dwidth ${DW}x${expDwH}).`);
}

// --- 3: origin forwarding (scale on the slice forwards the crop origin UNSCALED)
{
  let ok = 0;
  const deadline = Date.now() + 6000;
  while (ok < 3 && Date.now() < deadline) {
    const r = pull(scFov);
    if (r) {
      assert.equal(r.width, FOV0.w, "slice-scale out width = round(sliceW*0.5)");
      assert.equal(r.height, FOV0.h, "slice-scale out height = round(sliceH*0.5)");
      assert.equal(r.originX, R0.x, "origin forwarded UNSCALED (x = slice crop x, not scaled)");
      assert.equal(r.originY, R0.y, "origin forwarded UNSCALED (y = slice crop y)");
      ok++;
    } else await sleep(3);
  }
  assert(ok >= 3, `origin-forward frames (${ok})`);
  const p = A.scaleProbeAll()[scFovId];
  assert.equal(p.name, scFovId, "scale meter name == pipeId (node id)");
  assert.equal(p.activeWidth, FOV0.w, "probe activeWidth");
  assert.equal(p.activeHeight, FOV0.h, "probe activeHeight");
  assert.equal(p.originX, R0.x, "probe originX (unscaled)");
  assert.equal(p.originY, R0.y, "probe originY (unscaled)");
  assert(p.outputs.scale.count >= 3, "scale outputs metered");
  console.log("25-scale-pipe: origin forwarding (unscaled) OK (frame + probe).");
}

// --- 4: variable input dims — steer the slice, scale tracks new dims + origin -
{
  assert.equal(A.setFoveaRect(slcId, R1), true, "steer the slice crop");
  let ok = 0;
  const deadline = Date.now() + 6000;
  while (ok < 2 && Date.now() < deadline) {
    const r = pull(scFov);
    if (r && r.width === FOV1.w && r.height === FOV1.h) {
      assert.equal(r.originX, R1.x, "new origin forwarded after slice steer");
      assert.equal(r.originY, R1.y, "new origin.y forwarded");
      ok++;
    } else await sleep(3);
  }
  assert(ok >= 2, `scale recomputed out dims from the NEW active input dims (${ok})`);
  console.log(`25-scale-pipe: variable input dims OK (out ${FOV1.w}x${FOV1.h} from steered slice, new origin).`);
}

// --- 5: reactive setScaleParams — swap params, applied on the next frame ------
{
  assert.equal(A.setScaleParams("camera/none/scale/x", { ratio: 0.5 }), false, "unknown pipe -> false");
  assert.throws(() => A.setScaleParams(scFovId, { ratio: 1, dsize: { width: 1, height: 1 } }), /EXACTLY one/, "ambiguous params throw");
  const NS = { w: 40, h: 30 };
  assert.equal(A.setScaleParams(scFovId, { dsize: { width: NS.w, height: NS.h } }), true, "retune slice-scale to dsize");
  let ok = 0;
  const deadline = Date.now() + 6000;
  while (ok < 2 && Date.now() < deadline) {
    const r = pull(scFov);
    if (r && r.width === NS.w && r.height === NS.h) {
      assert.equal(r.originX, R1.x, "origin still forwarded after retune");
      ok++;
    } else await sleep(3);
  }
  assert(ok >= 2, `reactive param swap applied on the next frame (${ok})`);
  const p = A.scaleProbeAll()[scFovId];
  assert.equal(p.activeWidth, NS.w, "probe reflects retuned dsize width");
  assert.equal(p.activeHeight, NS.h, "probe reflects retuned dsize height");
  console.log("25-scale-pipe: reactive setScaleParams OK (applied next frame).");
}

// --- 6: detach idempotency ---------------------------------------------------
reader.close(scFov.rh); P.disconnect(scFovId);
assert.equal(A.detachScalePipe(scFovId), true, "detach slice-scale");
assert.equal(A.detachScalePipe(scFovId), false, "detach is idempotent");
assert.equal(A.scaleProbeAll()[scFovId], undefined, "detached id absent from the registry");
P.close(scFovId); P.drop(scFovId);
console.log("25-scale-pipe: detach idempotency OK.");

// --- orderly teardown (B-20 pattern) → natural exit --------------------------
for (const [s, id] of [[scId, scIdId], [scHalf, scHalfId], [scDs, scDsId], [scDw, scDwId]] as const) {
  reader.close(s.rh); P.disconnect(id);
  assert.equal(A.detachScalePipe(id), true, `detach ${id}`);
  P.close(id); P.drop(id);
}
reader.close(raw.rh); P.disconnect(rawId);
assert.equal(A.detachFoveaPipe(slcId), true, "detach slice");
assert.equal(A.detachUndistortPipe(undId), true, "detach undistort");
A.detachCameraPipe(rawId);
for (const id of [rawId, undId, slcId]) { P.close(id); P.drop(id); }
camera.release();

console.log("25-scale-pipe: orderly teardown complete — exiting naturally.");
