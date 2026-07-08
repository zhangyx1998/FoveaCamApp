// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Undistort brick v2 (unified-time-and-topology §5): undistorted streams as
// their OWN pipes, produced by a native INTRINSIC remap thread CHAINED on the
// converter's in-process owned-frame tap (BGRA in — never the raw stream),
// maps built at attach from the plain persisted CameraCalibration JSON. NO
// hardware (fake camera). Proves:
//   1. ZERO-DISTORTION PASSTHROUGH — with dist_coeffs = 0 the maps are the
//      identity, so the undistort pipe's bytes MATCH the raw converter pipe's
//      for the SAME camera frame (matched on FrameMeta.deviceTimestamp) —
//      chained through the tap (attach by CONVERT PIPEID, the v2 form).
//   2. NONZERO DISPLACEMENT — with a strong barrel k1, matched frames DIFFER
//      substantially from raw (pixels displaced per the maps), while staying
//      structurally valid BGRA (B==G==R; remap interpolates channels alike).
//      Attached with the LEGACY Camera argument (private #convert chain) —
//      back-compat proof.
//   3. GATE PARK + RESUME — disconnecting the last consumer parks the thread
//      (pipe's own connectPipe refcount via setConsumerGate); reconnecting
//      resumes production (fresh frames flow).
//   4. undistortProbeAll() exposes per-pipe ThreadMeter snapshots + the v2
//      {variant, calibratedClock} surface.
//   5. ORDERLY teardown (B-20 pattern) → natural exit 0, zero leak warns.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/18-undistort-pipe.ts

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, __origin__ } from "core";

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(join(dirname(__origin__), `${prefix}-shm-reader.node`)) as {
  open(seg: string): object;
  readInto(h: object, dest: ArrayBuffer, lastSeq: bigint):
    | { seq: bigint; meta: { deviceTimestamp: bigint }; closed?: undefined }
    | { closed: true }
    | null;
  close(h: object): void;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = Pipe as any, A = Aravis as any;

// JS Mat = TypedArray + {shape, channels} (app/lib/mat.ts `makeMat` shape).
const mat = (nums: number[], shape: number[]) =>
  Object.assign(new Float64Array(nums), { shape, channels: 1 });

A.enableFakeCamera();
const camera = (await A.Camera.list())[0];
const probe0 = await camera.grab(2_000_000);
const [height, width] = probe0.raw.shape as [number, number];
probe0.release?.();
const serial = String(camera.serial ?? "0");

// The persisted-CameraCalibration-JSON shape (calibrate-intrinsic output).
const f = width * 0.8, cx = width / 2, cy = height / 2;
const calibration = (k1: number) => ({
  sensor_size: { width, height },
  camera_matrix: mat([f, 0, cx, 0, f, cy, 0, 0, 1], [3, 3]),
  dist_coeffs: mat([k1, 0, 0, 0, 0], [1, 5]),
  rvecs: [],
  tvecs: [],
});

const channels = 4; // BGRA8 everywhere (the access modifier via spec.pixelFormat)
const bytes = width * height * channels;
const px = width * height;
const advertise = (id: string) =>
  P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width, height, channels, stride: width * channels, bytesPerFrame: bytes, ringDepth: 4 });

const rawId = `camera:${serial}`;
const idnId = `undistort:${serial}`; // zero-distortion (identity maps)
const dstId = `undistort:${serial}@barrel`; // strong barrel k1 (the @-suffix convention)
advertise(rawId); advertise(idnId); advertise(dstId);

assert.equal(A.attachCameraPipe(camera, rawId), true, "raw converter attaches");
// v2 form: chained on the CONVERT brick by pipeId ({cal} = intrinsic variant).
assert.equal(A.attachUndistortPipe(rawId, idnId, { cal: calibration(0) }), true, "identity undistort attaches (chained on convert pipe)");
// Legacy form: Camera + positional calibration (private #convert chain).
assert.equal(A.attachUndistortPipe(camera, dstId, calibration(-0.4)), true, "barrel undistort attaches (legacy camera arg)");

// Connect all three (main brokers; connect drives each pipe's consumer gate).
const open = (id: string) => ({ rh: reader.open(P.connect(id).shmName), dest: new ArrayBuffer(bytes), lastSeq: 0n });
const raw = open(rawId), idn = open(idnId), dst = open(dstId);

// --- collect frames, matching on deviceTimestamp across pipes ---------------
type Cmp = { equal: number; different: number; checked: number };
const rawByTs = new Map<string, Uint8Array>(); // ts -> copied raw bytes
const idnCmp: Cmp = { equal: 0, different: 0, checked: 0 };
const dstCmp: Cmp = { equal: 0, different: 0, checked: 0 };

function pull(s: { rh: object; dest: ArrayBuffer; lastSeq: bigint }): bigint | null {
  const r = reader.readInto(s.rh, s.dest, s.lastSeq);
  if (!r || (r as any).closed) return null;
  s.lastSeq = (r as any).seq;
  return (r as any).meta.deviceTimestamp as bigint;
}

function compare(cmp: Cmp, got: Uint8Array, ref: Uint8Array, name: string) {
  // BGRA structure survives remap (channels interpolated identically).
  for (let p = 0; p < px; p += 997) {
    assert.equal(got[p * 4], got[p * 4 + 1], `${name}: B==G`);
    assert.equal(got[p * 4 + 1], got[p * 4 + 2], `${name}: G==R`);
  }
  const c = Math.floor((cy * width + cx)) * 4; // central pixel stays in-range
  assert.equal(got[c + 3], 255, `${name}: central alpha saturated`);
  // Pixel-displacement measure vs the SAME raw frame (B channel).
  let moved = 0;
  for (let p = 0; p < px; p++) if (Math.abs(got[p * 4] - ref[p * 4]) > 2) moved++;
  cmp.checked++;
  if (moved === 0) cmp.equal++;
  if (moved > px * 0.01) cmp.different++;
}

{
  const deadline = Date.now() + 10_000;
  while ((idnCmp.checked < 3 || dstCmp.checked < 3) && Date.now() < deadline) {
    const ts = pull(raw);
    if (ts !== null) rawByTs.set(String(ts), new Uint8Array(raw.dest.slice(0))); // copy out (dest reused)
    if (rawByTs.size > 32) rawByTs.delete(rawByTs.keys().next().value!);
    const t1 = pull(idn);
    if (t1 !== null && rawByTs.has(String(t1)) && idnCmp.checked < 3)
      compare(idnCmp, new Uint8Array(idn.dest), rawByTs.get(String(t1))!, "identity");
    const t2 = pull(dst);
    if (t2 !== null && rawByTs.has(String(t2)) && dstCmp.checked < 3)
      compare(dstCmp, new Uint8Array(dst.dest), rawByTs.get(String(t2))!, "barrel");
    if (ts === null && t1 === null && t2 === null) await sleep(3);
  }
}
assert(idnCmp.checked >= 3, `matched identity frames (${idnCmp.checked})`);
assert(dstCmp.checked >= 3, `matched barrel frames (${dstCmp.checked})`);
// 1. zero-distortion = byte-level passthrough of the raw converter pipe.
assert.equal(idnCmp.equal, idnCmp.checked, `identity maps pass bytes through (${idnCmp.equal}/${idnCmp.checked})`);
// 2. strong barrel = substantial displacement on every matched frame.
assert.equal(dstCmp.different, dstCmp.checked, `barrel maps displace pixels (${dstCmp.different}/${dstCmp.checked})`);

// 4. per-pipe ThreadMeter snapshots via undistortProbeAll (+ v2 variant surface).
const probes = A.undistortProbeAll();
for (const id of [idnId, dstId]) {
  assert(probes[id], `probe has ${id}`);
  assert(probes[id].outputs.undistorted.count >= 3, `${id} metered ${probes[id].outputs.undistorted.count} outputs`);
  assert(probes[id].name.startsWith("undistort:"), "meter name");
  assert.equal(probes[id].variant, "intrinsic", `${id} intrinsic variant`);
  assert.equal(probes[id].calibratedClock, false, `${id} clock not calibrated`);
}
console.log(`18-undistort-pipe: identity=${idnCmp.equal}/${idnCmp.checked} passthrough, barrel=${dstCmp.different}/${dstCmp.checked} displaced, probes OK.`);

// --- 3. gate park + resume on the identity pipe ------------------------------
reader.close(idn.rh);
P.disconnect(idnId); // last consumer gone -> gate(false) -> thread parks
await sleep(150);
const re = open(idnId); // reconnect -> gate(true) -> production resumes
let resumed = 0;
{
  const deadline = Date.now() + 5000;
  while (resumed < 2 && Date.now() < deadline) {
    if (pull(re) !== null) resumed++;
    else await sleep(3);
  }
}
assert(resumed >= 2, `undistort pipe resumed after reconnect (${resumed})`);
console.log("18-undistort-pipe: gate park+resume OK.");

// --- 5. ORDERLY teardown (B-20 pattern) --------------------------------------
reader.close(raw.rh); reader.close(dst.rh); reader.close(re.rh);
P.disconnect(rawId); P.disconnect(dstId); P.disconnect(idnId);
assert.equal(A.detachUndistortPipe(idnId), true, "detach identity");
assert.equal(A.detachUndistortPipe(dstId), true, "detach barrel");
assert.equal(A.detachUndistortPipe(dstId), false, "detach is idempotent");
A.detachCameraPipe(rawId);
for (const id of [rawId, idnId, dstId]) { P.close(id); P.drop(id); }
camera.release(); // last Arv ref -> destroyed; event loop empties

// Natural exit 0 (no cleanup/process.exit) IS the clean-teardown proof.
console.log("18-undistort-pipe: orderly teardown complete — exiting naturally.");
