// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Fovea brick v2 (unified-time-and-topology §5): spawn/cancel-able per-fovea
// producer threads RE-BASED on the upstream brick's in-process owned-frame
// tap (chain convert → undistort → fovea; the crop is a PLAIN ROI copy — the
// fused map-ROI path is retired), feeding DYNAMIC pipes (C-20: max-footprint
// ring, per-frame active w/h in the slot header, epoch reuse-safe ids). NO
// hardware (fake camera). Proves:
//   1. RAW-CROP IDENTITY — a fovea chained on the CONVERT brick equals the
//      same rect sliced from the raw converter pipe's frame (matched on
//      FrameMeta.deviceTimestamp — the test-18 technique).
//   2. UNDISTORTED-CROP IDENTITY — a fovea chained on the UNDISTORT brick
//      equals the same rect sliced from the full `undistort` pipe frame
//      (crop of the undistorted output — the chain finally matches the id).
//   3. MID-FLIGHT setFoveaRect — steering the crop live changes the per-frame
//      ACTIVE w/h the reader surfaces (v3 slot header), no re-attach.
//   4. SPAWN/CANCEL CHURN — advertise+attach+connect / disconnect+detach+
//      close+drop ×6 on the SAME id (LEGACY Camera-source form — private
//      #convert chain, back-compat): every generation flows frames, epochs
//      bump (fresh shm segment names), nothing leaks.
//   5. foveaProbeAll — keyed by pipeId (= C-24 node id), meter name == key,
//      frame-bound activeWidth/Height/originX/originY fields; converter +
//      undistort probes now also carry name == pipeId (B-24 rename).
//   6. ORDERLY teardown (B-20 pattern) → natural exit 0, zero leak warns.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/20-fovea-pipe.ts

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

const f = W * 0.8, cx = W / 2, cy = H / 2;
const cal = {
  sensor_size: { width: W, height: H },
  camera_matrix: mat([f, 0, cx, 0, f, cy, 0, 0, 1], [3, 3]),
  dist_coeffs: mat([-0.4, 0, 0, 0, 0], [1, 5]),
  rvecs: [],
  tvecs: [],
};

const CH = 4; // BGRA8
const fullBytes = W * H * CH;
const MAXW = 256, MAXH = 192; // fovea ring footprint (C-20 max)
const maxBytes = MAXW * MAXH * CH;
const R0 = { x: 64, y: 48, width: 128, height: 96 }; // initial crop

const advertiseFull = (id: string) =>
  P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width: W, height: H, channels: CH, stride: W * CH, bytesPerFrame: fullBytes, ringDepth: 4 });
const advertiseFovea = (id: string) =>
  P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width: R0.width, height: R0.height, channels: CH, stride: R0.width * CH, bytesPerFrame: R0.width * R0.height * CH, ringDepth: 4, maxWidth: MAXW, maxHeight: MAXH, maxBytes });

const rawId = `camera/${serial}/convert`; // C-24 path-like spelling
const undId = `camera/${serial}/undistort`;
const fovRawId = `camera/${serial}/convert/fovea/0`;
const fovUndId = `camera/${serial}/undistort/fovea/0`;

advertiseFull(rawId); advertiseFull(undId);
advertiseFovea(fovRawId); advertiseFovea(fovUndId);
assert.equal(A.attachCameraPipe(camera, rawId), true, "raw converter attaches");
// v2 chain: undistort taps the convert brick; foveas tap convert/undistort.
assert.equal(A.attachUndistortPipe(rawId, undId, { cal }), true, "undistort attaches (chained on convert)");
assert.equal(A.attachFoveaPipe(rawId, fovRawId, { rect: R0 }), true, "raw fovea attaches (chained on convert)");
assert.equal(A.attachFoveaPipe(undId, fovUndId, { rect: R0 }), true, "undistorted fovea attaches (chained on undistort)");
// The fused map-ROI form is retired: cal + a source pipeId must be rejected.
assert.throws(() => A.attachFoveaPipe(undId, fovUndId, { rect: R0, cal }), /cal/, "cal with a source pipeId throws");

type Src = { rh: object; dest: ArrayBuffer; lastSeq: bigint };
const open = (id: string, bytes: number): Src => ({ rh: reader.open(P.connect(id).shmName), dest: new ArrayBuffer(bytes), lastSeq: 0n });
const pull = (s: Src) => {
  const r = reader.readInto(s.rh, s.dest, s.lastSeq);
  if (!r || (r as any).closed) return null;
  s.lastSeq = (r as any).seq;
  return r as { seq: bigint; width: number; height: number; meta: { deviceTimestamp: bigint } };
};

// Slice rect R out of a full W×H BGRA frame (row-wise).
function slice(full: Uint8Array, r: { x: number; y: number; width: number; height: number }): Uint8Array {
  const out = new Uint8Array(r.width * r.height * CH);
  for (let row = 0; row < r.height; row++)
    out.set(full.subarray(((r.y + row) * W + r.x) * CH, ((r.y + row) * W + r.x + r.width) * CH), row * r.width * CH);
  return out;
}
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const raw = open(rawId, fullBytes), und = open(undId, fullBytes);
const fovRaw = open(fovRawId, maxBytes), fovUnd = open(fovUndId, maxBytes);

// --- 1+2: identity checks, matching frames on deviceTimestamp ---------------
{
  const rawByTs = new Map<string, Uint8Array>();
  const undByTs = new Map<string, Uint8Array>();
  let rawOk = 0, undOk = 0;
  const deadline = Date.now() + 12_000;
  while ((rawOk < 3 || undOk < 3) && Date.now() < deadline) {
    let idle = true;
    let r = pull(raw);
    if (r) { rawByTs.set(String(r.meta.deviceTimestamp), new Uint8Array(raw.dest.slice(0))); idle = false; }
    r = pull(und);
    if (r) { undByTs.set(String(r.meta.deviceTimestamp), new Uint8Array(und.dest.slice(0))); idle = false; }
    for (const m of [rawByTs, undByTs]) if (m.size > 32) m.delete(m.keys().next().value!);
    r = pull(fovRaw);
    if (r && rawOk < 3) {
      idle = false;
      const ref = rawByTs.get(String(r.meta.deviceTimestamp));
      if (ref) {
        assert.equal(r.width, R0.width, "fovea active width = rect");
        assert.equal(r.height, R0.height, "fovea active height = rect");
        const got = new Uint8Array(r.width * r.height * CH);
        got.set(new Uint8Array(fovRaw.dest, 0, got.length));
        assert(bytesEqual(got, slice(ref, R0)), "raw fovea == raw-frame subrect (byte-exact)");
        rawOk++;
      }
    }
    r = pull(fovUnd);
    if (r && undOk < 3) {
      idle = false;
      const ref = undByTs.get(String(r.meta.deviceTimestamp));
      if (ref) {
        const got = new Uint8Array(r.width * r.height * CH);
        got.set(new Uint8Array(fovUnd.dest, 0, got.length));
        assert(bytesEqual(got, slice(ref, R0)), "undistorted fovea == undistort-frame subrect (chained-crop identity)");
        undOk++;
      }
    }
    if (idle) await sleep(3);
  }
  assert(rawOk >= 3, `raw-crop identity matched frames (${rawOk})`);
  assert(undOk >= 3, `undistorted-crop identity matched frames (${undOk})`);
  console.log(`20-fovea-pipe: raw-crop identity ${rawOk}/3, undistorted-crop identity ${undOk}/3.`);
}

// --- 3: mid-flight setFoveaRect → per-frame ACTIVE w/h changes ---------------
{
  const R1 = { x: 200, y: 100, width: 240, height: 160 }; // grown, still ≤ max
  assert.equal(A.setFoveaRect(fovRawId, R1), true, "setFoveaRect on a live pipe");
  assert.equal(A.setFoveaRect("camera/none/fovea/9", R1), false, "unknown id -> false");
  let seen = 0;
  const deadline = Date.now() + 5000;
  while (seen < 2 && Date.now() < deadline) {
    const r = pull(fovRaw) as (ReturnType<typeof pull> & { originX?: number; originY?: number }) | null;
    if (r && r.width === R1.width && r.height === R1.height) {
      // v4: the crop origin is FRAME-BOUND — it rides the slot header with the
      // active size, so this exact frame carries its own rect (no racy echo).
      assert.equal((r as any).originX, R1.x, "per-frame originX (slot header v4)");
      assert.equal((r as any).originY, R1.y, "per-frame originY (slot header v4)");
      seen++;
    } else await sleep(3);
  }
  assert(seen >= 2, `active w/h switched to the steered rect (${seen})`);
  // probe surfaces the FRAME-BOUND rect (origin + active dims)
  const p = A.foveaProbeAll()[fovRawId];
  assert.equal(p.activeWidth, R1.width, "probe activeWidth");
  assert.equal(p.activeHeight, R1.height, "probe activeHeight");
  assert.equal(p.originX, R1.x, "probe originX");
  assert.equal(p.originY, R1.y, "probe originY");
  console.log("20-fovea-pipe: mid-flight setFoveaRect steering OK (active w/h + origin).");
}

// --- 5: probes keyed by pipeId, meter name == key (incl. B-24 renames) -------
{
  const fov = A.foveaProbeAll();
  for (const id of [fovRawId, fovUndId]) {
    assert(fov[id], `foveaProbeAll has ${id}`);
    assert.equal(fov[id].name, id, "fovea meter name == pipeId (node id)");
    assert(fov[id].outputs.fovea.count >= 3, "fovea outputs metered");
  }
  assert.equal(fov[fovRawId].undistorted, false);
  assert.equal(fov[fovUndId].undistorted, true);
  assert.equal(A.converterProbeAll()[rawId].name, rawId, "converter meter renamed to pipeId");
  assert.equal(A.undistortProbeAll()[undId].name, undId, "undistort meter renamed to pipeId");
  console.log("20-fovea-pipe: probes keyed+named by node id OK.");
}

// Release the identity fixtures before the churn phase.
reader.close(fovUnd.rh); P.disconnect(fovUndId);
assert.equal(A.detachFoveaPipe(fovUndId), true, "detach undistorted fovea");
P.close(fovUndId); P.drop(fovUndId);
reader.close(fovRaw.rh); P.disconnect(fovRawId);
assert.equal(A.detachFoveaPipe(fovRawId), true, "detach raw fovea");
assert.equal(A.detachFoveaPipe(fovRawId), false, "detach is idempotent");
P.close(fovRawId); P.drop(fovRawId);

// --- 4: spawn/cancel churn on ONE reused id (multi-fovea's mid-flight case) --
{
  const id = `camera/${serial}/convert/fovea/hot`;
  const names = new Set<string>();
  for (let gen = 0; gen < 6; gen++) {
    advertiseFovea(id);
    assert.equal(A.attachFoveaPipe(camera, id, { rect: R0 }), true, `spawn #${gen}`);
    const h = P.connect(id);
    names.add(h.shmName); // epoch-suffixed segment name
    const s: Src = { rh: reader.open(h.shmName), dest: new ArrayBuffer(maxBytes), lastSeq: 0n };
    let got = 0;
    const deadline = Date.now() + 4000;
    while (got < 2 && Date.now() < deadline) {
      if (pull(s)) got++;
      else await sleep(3);
    }
    assert(got >= 2, `generation ${gen} flowed frames (${got})`);
    reader.close(s.rh);
    P.disconnect(id);
    assert.equal(A.detachFoveaPipe(id), true, `cancel #${gen}`);
    P.close(id);
    P.drop(id);
  }
  assert.equal(names.size, 6, `every churn generation got a FRESH segment (epochs bumped: ${names.size}/6)`);
  assert.equal(A.foveaProbeAll()[id], undefined, "churned id absent from the registry");
  console.log("20-fovea-pipe: spawn/cancel churn x6 leak-free, epochs bump.");
}

// --- 6: ORDERLY teardown (B-20 pattern) → natural exit -----------------------
reader.close(raw.rh); reader.close(und.rh);
P.disconnect(rawId); P.disconnect(undId);
A.detachCameraPipe(rawId);
assert.equal(A.detachUndistortPipe(undId), true, "detach undistort");
for (const id of [rawId, undId]) { P.close(id); P.drop(id); }
camera.release();

console.log("20-fovea-pipe: orderly teardown complete — exiting naturally.");
