// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// real-2 (B-25): multi-target KCF on ONE C++ thread — the LAST on-loop vision
// (multi-fovea's JS runtime.onCenterFrame KCF) as a native graph brick. NO
// hardware (fake camera: a Mono8 ramp shifting 1px/frame). Proves:
//   1. BATCHED per-frame results — one node, one output stream: every batch
//      carries ALL armed targets ({id, ok, bbox|null, updateMs}) with one
//      seq/deviceTimestamp (per-frame coherence), seq monotonic.
//   2. ARM/DISARM CHURN at runtime — re-arm recenters (init-frame reports the
//      armed roi), disarm shrinks the batch, disarm-all idles the stream
//      (probe targets empty, output count parks), re-arm resumes. MAX 8 cap.
//   3. RAW-MODE PARITY — a cal-less multi tracker and 12's single
//      KcfTrackerStream track the SAME rect on the SAME camera; matched on
//      deviceTimestamp their ok/found VERDICTS agree (and bboxes when both
//      ok). Note: on the fake ramp cv::TrackerKCF reports found on only a few
//      frames (12's test never required found either) — parity is "same
//      engine, same frames, same verdicts", not sustained tracking.
//   4. DETERMINISTIC drop metering (post-d2bffce pattern): injected 120ms
//      stall >> the ~42ms frame interval ⇒ dropTotal climbs, busyMs > 0.
//   5. PROBE — name == the C-24 node id (camera/<serial>/kcf-multi, supplied
//      via opts.name, never hardcoded natively), per-target block
//      {id, ok, bbox, updateMs, ageMs}, undistorted flag; default name
//      "tracker:multi" when opts.name omitted.
//   6. ORDERLY teardown (B-20 pattern) → natural exit 0, zero leak warns.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/21-multi-kcf.ts

import assert from "node:assert/strict";
import { Aravis, Tracker, __origin__ } from "core";

void __origin__;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rect = { x: number; y: number; width: number; height: number };
type BatchTarget = { id: string; ok: boolean; bbox: Rect | null; updateMs: number };
type Batch = { seq: number; deviceTimestamp: bigint; targets: BatchTarget[] };
type SingleResult = { found: boolean; bbox: Rect | null; seq: number; deviceTimestamp: bigint };
type Snapshot = {
  name: string;
  busyMs: number;
  dropTotal: number;
  inputs: Record<string, { count: number; maxIntervalMs: number }>;
  outputs: Record<string, { count: number }>;
  targets: Array<{ id: string; ok: boolean; bbox: Rect | null; updateMs: number; ageMs: number }>;
  undistorted: boolean;
};

const A = Aravis as any, T = Tracker as any;
const mat = (nums: number[], shape: number[]) =>
  Object.assign(new Float64Array(nums), { shape, channels: 1 });

A.enableFakeCamera();
const camera = (await A.Camera.list())[0];
const probe0 = await camera.grab(2_000_000);
const [H, W] = probe0.raw.shape as [number, number];
probe0.release?.();
const serial = String(camera.serial ?? "0");
const nodeId = `camera/${serial}/kcf-multi`; // C-24 nodeId.kcfMulti(serial)

const f = W * 0.8;
const cal = {
  sensor_size: { width: W, height: H },
  camera_matrix: mat([f, 0, W / 2, 0, f, H / 2, 0, 0, 1], [3, 3]),
  dist_coeffs: mat([-0.4, 0, 0, 0, 0], [1, 5]),
  rvecs: [],
  tvecs: [],
};

const roiAt = (fx: number, fy: number): Rect => ({
  x: Math.floor(W * fx), y: Math.floor(H * fy), width: 72, height: 72 });

// ---- 1: cal-mode multi — batched per-frame results --------------------------
const multi = T.createMultiTracker(camera, { cal, name: nodeId });
const R = { t0: roiAt(0.2, 0.2), t1: roiAt(0.5, 0.35), t2: roiAt(0.3, 0.55) };
for (const [id, r] of Object.entries(R)) multi.arm(id, r);

async function batches(n: number, timeoutMs = 8000): Promise<Batch[]> {
  const out: Batch[] = [];
  const deadline = Date.now() + timeoutMs;
  for await (const b of multi as AsyncIterable<Batch>) {
    out.push(b);
    if (out.length >= n || Date.now() > deadline) break;
  }
  return out;
}

{
  const got = await batches(6);
  assert(got.length >= 6, `batched results streamed (${got.length})`);
  let lastSeq = 0;
  for (const b of got) {
    assert(b.seq > lastSeq, "seq strictly increases");
    lastSeq = b.seq;
    assert.equal(b.targets.length, 3, "every batch carries ALL armed targets");
    assert.deepEqual(b.targets.map((t) => t.id).sort(), ["t0", "t1", "t2"], "target ids");
    assert(typeof b.deviceTimestamp === "bigint", "frame-coherent deviceTimestamp");
    for (const t of b.targets) {
      assert(typeof t.updateMs === "number" && t.updateMs >= 0, "per-target updateMs");
      if (t.ok) {
        const bb = t.bbox!;
        assert(bb.x >= 0 && bb.y >= 0 && bb.x < W && bb.y < H, `bbox in-bounds (${t.id})`);
      }
    }
  }
  console.log(`21-multi-kcf: batched 3-target results OK (${got.length} batches).`);
}

// ---- 2: churn — re-arm recenters, disarm shrinks, disarm-all idles, MAX 8 ---
{
  const R1 = roiAt(0.65, 0.6);
  multi.arm("t1", R1); // re-arm = re-init at the new rect
  let recentered = false;
  for (const b of await batches(4)) {
    const t1 = b.targets.find((t) => t.id === "t1")!;
    if (t1.ok && t1.bbox && t1.bbox.x === R1.x && t1.bbox.y === R1.y) recentered = true;
  }
  assert(recentered, "re-arm recentered t1 (init frame reports the armed roi)");

  multi.disarm("t2");
  const shrunk = await batches(3);
  assert(shrunk.every((b) => b.targets.length === 2 && !b.targets.some((t) => t.id === "t2")),
    "disarm shrinks the batch");

  // MAX 8 cap: arm 9 total → the 9th NEW id is dropped natively.
  for (let i = 0; i < 7; i++) multi.arm(`x${i}`, roiAt(0.1 + i * 0.08, 0.7));
  await batches(2);
  let snap: Snapshot = multi.probe();
  assert.equal(snap.targets.length, 8, `MAX 8 cap enforced (${snap.targets.length})`);
  assert(!snap.targets.some((t) => t.id === "x6"), "9th target dropped");

  // disarm ALL → the stream idles (no new outputs), probe targets empty.
  for (const t of snap.targets) multi.disarm(t.id);
  await sleep(300);
  const c1 = (multi.probe() as Snapshot).outputs.track.count;
  await sleep(400);
  snap = multi.probe();
  assert.equal(snap.targets.length, 0, "probe targets empty after disarm-all");
  assert.equal(snap.outputs.track.count, c1, "output count parks while idle");

  multi.arm("t0", R.t0); // resume
  const resumed = await batches(2);
  assert(resumed.length >= 2 && resumed.every((b) => b.targets.length === 1), "re-arm resumes");
  console.log("21-multi-kcf: arm/disarm churn + MAX-8 cap + idle/resume OK.");
}

// ---- 5 (part): probe identity -----------------------------------------------
{
  const snap: Snapshot = multi.probe();
  assert.equal(snap.name, nodeId, "meter/probe name == C-24 node id (via opts.name)");
  assert.equal(snap.undistorted, true, "cal mode flagged");
  assert(snap.inputs.frame.count > 0 && snap.inputs.frame.maxIntervalMs > 0, "frame intervals metered");
  const t0 = snap.targets.find((t) => t.id === "t0")!;
  assert(t0 && t0.ageMs >= 0 && typeof t0.updateMs === "number", "per-target probe block");
}

// ---- 4: deterministic drop metering under stall ------------------------------
{
  multi.stall(120); // >> ~42ms fake-camera interval, inside meter begin/end
  const before = (multi.probe() as Snapshot).dropTotal;
  let consumed = 0;
  const deadline = Date.now() + 8000;
  for await (const _b of multi as AsyncIterable<Batch>) {
    if (++consumed >= 6 || Date.now() > deadline) break;
  }
  const after: Snapshot = multi.probe();
  assert(after.dropTotal > before, `drops climb under stall (${before} -> ${after.dropTotal})`);
  assert(after.busyMs > 0, "busy time metered under stall (deterministic)");
  multi.stall(0);
  console.log(`21-multi-kcf: stall drops ${before} -> ${after.dropTotal}, busyMs=${after.busyMs.toFixed(1)}.`);
}

// ---- 3: raw-mode parity vs 12's single KcfTrackerStream ---------------------
{
  const rawMulti = T.createMultiTracker(camera); // no opts: raw mode, default name
  assert.equal((rawMulti.probe() as Snapshot).name, "tracker:multi", "default name (legacy-safe)");
  assert.equal((rawMulti.probe() as Snapshot).undistorted, false, "raw mode flagged");
  const single = T.createTracker(camera);
  const R3 = roiAt(0.4, 0.4);
  rawMulti.arm("p", R3);
  single.arm(R3);

  // Collect both sides' VERDICTS, join on deviceTimestamp; skip each side's
  // first few results (the trackers init on slightly different frames).
  const multiByTs = new Map<string, { ok: boolean; bbox: Rect | null }>();
  const singles: SingleResult[] = [];
  const collectMulti = (async () => {
    let n = 0;
    const deadline = Date.now() + 10_000;
    for await (const b of rawMulti as AsyncIterable<Batch>) {
      const t = b.targets.find((x) => x.id === "p");
      if (++n > 3 && t) multiByTs.set(String(b.deviceTimestamp), { ok: t.ok, bbox: t.bbox });
      if (n >= 45 || Date.now() > deadline) break;
    }
  })();
  const collectSingle = (async () => {
    let n = 0;
    const deadline = Date.now() + 10_000;
    for await (const r of single as AsyncIterable<SingleResult>) {
      if (++n > 3) singles.push(r);
      if (n >= 45 || Date.now() > deadline) break;
    }
  })();
  await Promise.all([collectMulti, collectSingle]);

  let matched = 0, agree = 0;
  for (const s of singles) {
    const m = multiByTs.get(String(s.deviceTimestamp));
    if (!m) continue;
    matched++;
    if (m.ok === s.found) agree++;
    if (m.ok && s.found)
      assert(Math.abs(m.bbox!.x - s.bbox!.x) <= 5 && Math.abs(m.bbox!.y - s.bbox!.y) <= 5,
        `raw parity bbox: multi(${m.bbox!.x},${m.bbox!.y}) vs single(${s.bbox!.x},${s.bbox!.y})`);
  }
  assert(matched >= 10, `parity pairs matched on deviceTimestamp (${matched})`);
  assert(agree / matched >= 0.8, `verdicts agree on identical frames (${agree}/${matched})`);
  console.log(`21-multi-kcf: raw-mode parity vs single KCF OK (${agree}/${matched} verdicts agree).`);

  rawMulti.release();
  single.release();
}

// ---- 6: ORDERLY teardown → natural exit --------------------------------------
multi.release();
camera.release();
console.log("21-multi-kcf: orderly teardown complete — exiting naturally.");
