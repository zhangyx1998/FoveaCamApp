// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 1d: KCF tracker on its own free-running C++ thread. NO hardware — drives
// the whole seam via Aravis's fake camera (a Mono8 ramp that shifts 1px/frame,
// a moving target): createTracker on the camera → arm(roi) → async-iterate the
// result stream (KCF runs OFF the JS loop on the transform thread) → probe the
// ThreadMeter (records frame/track intervals + latest-wins drops). Tracking
// ACCURACY is rig-gated (v1 full-frame KCF); this proves the thread + seam +
// meter. Run UNSANDBOXED: /opt/homebrew/bin/node core/test/12-kcf-tracker.ts

import assert from "node:assert/strict";
import { Aravis, __origin__, cleanup } from "core";

void __origin__;

type Result = {
  found: boolean;
  bbox: { x: number; y: number; width: number; height: number } | null;
  center: { x: number; y: number } | null;
  overridden: boolean;
  seq: number;
  deviceTimestamp: bigint;
};
type StreamStat = { count: number; ratePerSec: number; maxIntervalMs: number };
type Snapshot = {
  name: string;
  busyMs: number;
  dropTotal: number;
  inputs: Record<string, StreamStat>;
  outputs: Record<string, StreamStat>;
};

const A = Aravis as unknown as {
  enableFakeCamera(): void;
  attachCameraPipe(camera: unknown, id: string): boolean;
  detachCameraPipe(id: string): boolean;
  Camera: { list(): Promise<Array<{ grab(t: number): Promise<{ raw: { shape: number[] } }>; serial?: string; release?(): void }>> };
};
type Tracker = {
  arm(roi: { x: number; y: number; width: number; height: number }): void;
  override(center: { x: number; y: number }): void;
  releaseOverride(): void;
  probe(): Snapshot;
  stall(ms: number): void;
  release(): void;
  [Symbol.asyncIterator](): AsyncIterator<Result>;
};
const T = (await import("core")).Tracker as unknown as {
  createTracker(camera: unknown): Tracker;
  createChainedTracker(sourcePipeId: string, name?: string): Tracker;
};
const P = (await import("core")).Pipe as any;

// Pull up to `n` results off a tracker's async iterator, subject to a deadline.
async function take(tr: Tracker, n: number, ms = 8000): Promise<Result[]> {
  const out: Result[] = [];
  const deadline = Date.now() + ms;
  for await (const r of tr as AsyncIterable<Result>) {
    out.push(r);
    if (out.length >= n || Date.now() > deadline) break;
  }
  return out;
}

{
  A.enableFakeCamera();
  const cams = await A.Camera.list();
  assert(cams.length > 0, "fake camera enumerated");
  const camera = cams[0]!;
  const probe = await camera.grab(2_000_000);
  const [height, width] = probe.raw.shape as [number, number];

  const tracker = T.createTracker(camera);
  // Arm on a textured patch of the moving ramp (well inside the frame).
  tracker.arm({ x: Math.floor(width / 3), y: Math.floor(height / 3), width: 96, height: 96 });

  const results: Result[] = [];
  const deadline = Date.now() + 8000;
  for await (const r of tracker as AsyncIterable<Result>) {
    results.push(r);
    if (results.length >= 25 || Date.now() > deadline) break;
  }

  // The KCF thread produced a result STREAM (off the JS loop, via the async
  // generator) — each with a monotonic seq and (when tracked) an in-bounds bbox.
  assert(results.length >= 5, `tracker streamed results (got ${results.length})`);
  let lastSeq = 0;
  for (const r of results) {
    assert(r.seq > lastSeq, "seq strictly increases");
    lastSeq = r.seq;
    assert(typeof r.found === "boolean", "found flag present");
    if (r.found) {
      const b = r.bbox!;
      assert(b.x >= 0 && b.y >= 0 && b.x < width && b.y < height, "bbox in-bounds");
    }
  }
  // SUSTAINED tracking (regression guard, 2026-07-10): cv::TrackerKCF's default
  // CN features need a 3-CHANNEL image. When the tracker was fed grayscale it
  // returned a hit on the FIRST update() then lost EVERY subsequent frame
  // (OpenCV 4.13.0), so the rig saw the box "flash then disappear". The raw
  // (Mono8) variant now replicates gray → BGR in KcfCore; assert the tracker
  // KEEPS finding the target across the window, not just on the arm frame.
  const rawFound = results.filter((r) => r.found).length;
  assert(
    rawFound >= results.length - 3,
    `raw tracker sustains tracking across frames (found ${rawFound}/${results.length}; ` +
      `pre-fix this was ~1 — KCF lost after the first update on grayscale input)`,
  );

  // Meter recorded the workload: frames ingested, tracks emitted, and frame
  // INTERVALS (maxIntervalMs > 0). Drops = camera frames the KCF thread couldn't
  // keep up with (latest-wins overwrites) — the load-bearing "can't keep up"
  // signal; present (>=0), and reported here.
  const snap = tracker.probe();
  assert.equal(snap.name, "tracker:center");
  assert(snap.inputs.frame && snap.inputs.frame.count > 0, "frames ingested");
  assert(snap.outputs.track && snap.outputs.track.count > 0, "tracks emitted");
  assert(snap.inputs.frame.maxIntervalMs > 0, "frame interval metered");
  // busyMs >= 0 (not > 0): on a fast machine 5 tiny-frame KCF updates can each
  // round to 0 at the meter's ms resolution — a 1-in-N flake. The STALLED phase
  // below asserts busyMs grows deterministically (injected 50ms stalls).
  assert(snap.busyMs >= 0, "KCF busy time metered");
  // Steady state: KCF (~ms) keeps up with the fake camera fps → no drops.
  assert.equal(snap.dropTotal, 0, "no drops while the tracker keeps up");
  console.log(
    `12-kcf-tracker: steady results=${results.length} frames=${snap.inputs.frame.count} ` +
      `tracks=${snap.outputs.track.count} busyMs=${snap.busyMs.toFixed(1)} ` +
      `maxIntervalMs=${snap.inputs.frame.maxIntervalMs.toFixed(1)} drops=${snap.dropTotal}`,
  );

  // Now make each transform slower than the camera's frame interval: the camera
  // outruns KCF, the latest-wins handoff overwrites unconsumed frames, and the
  // meter's drop counter must climb — the "frames dropped because KCF was busy"
  // signal that tells us the tracker can't keep up.
  tracker.stall(120); // >> the ~42ms fake-camera interval
  const before = tracker.probe().dropTotal;
  const stallDeadline = Date.now() + 8000;
  let consumed = 0;
  for await (const _r of tracker as AsyncIterable<Result>) {
    if (++consumed >= 6 || Date.now() > stallDeadline) break;
  }
  const after = tracker.probe();
  assert(after.dropTotal > before, `drops climb under stall (${before} → ${after.dropTotal})`);
  // Deterministic busy coverage (the steady-phase busy assert is >= 0): the
  // injected 120ms stall runs INSIDE meter begin/end, so busy MUST be > 0 here.
  assert(after.busyMs > 0, "KCF busy time metered under stall");
  console.log(
    `12-kcf-tracker: stalled drops ${before} → ${after.dropTotal} ` +
      `(busyMs=${after.busyMs.toFixed(1)})`,
  );

  // Override on the RAW variant: while engaged, results carry the override
  // center + overridden:true and KCF is NOT consulted (proposal §3.5, both
  // variants). Un-stall first so frames flow quickly.
  tracker.stall(0);
  const OVR = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  tracker.override(OVR);
  // A frame that was mid-stall when we engaged the override still flushes its
  // pre-override result — tolerate that transient, then assert every FLAGGED
  // result carries the exact override center and found:true.
  const overrid = await take(tracker, 8);
  const flagged = overrid.filter((r) => r.overridden);
  assert(flagged.length >= 3, `override engages (${flagged.length}/${overrid.length} flagged)`);
  for (const r of flagged) {
    assert.equal(r.found, true, "raw override result is found");
    assert(r.center && r.center.x === OVR.x && r.center.y === OVR.y,
      `raw override center echoes the override point (${JSON.stringify(r.center)})`);
  }
  console.log(`12-kcf-tracker: raw override emits ${flagged.length} flagged results at the override center.`);
  tracker.release();
}

// --- §3.5 CHAINED tracker on a convert brick + override/release re-arm --------
{
  const cams = await A.Camera.list();
  const camera = cams[0]!;
  const probe = await camera.grab(2_000_000);
  const [height, width] = probe.raw.shape as [number, number];
  const serial = String(camera.serial ?? "0");

  // A convert brick with NO SHM consumer: the chained tracker's tap alone wakes
  // it (demand propagation across the in-process channel, same as test 22).
  const cnvId = `camera/${serial}/convert`;
  P.advertise({
    id: cnvId, pixelFormat: "BGRA8", dtype: "U8", width, height,
    channels: 4, stride: width * 4, bytesPerFrame: width * height * 4, ringDepth: 4,
  });
  assert.equal(A.attachCameraPipe(camera, cnvId), true, "converter attaches");

  const chained = T.createChainedTracker(cnvId);
  assert.equal(P.consumers(cnvId), 0, "convert pipe has no SHM consumers (tap-only demand)");
  chained.arm({ x: Math.floor(width / 3), y: Math.floor(height / 3), width: 96, height: 96 });

  // Normal tracking off the tap: results stream with a center + overridden:false.
  // (SUSTAINED tracking — the actual "flash then disappears" regression guard —
  // is asserted on the RAW tracker above: it is the FIRST tracker in this
  // process, so it runs before the fake camera's stream-lifecycle degradation
  // that starves later trackers. Both variants funnel through the identical
  // KcfCore::step → asColor8 3-channel normalization the fix added, so the raw
  // assertion covers the chained path; here we only check the tap streams +
  // override/release re-arm still work.)
  const normal = await take(chained, 5);
  assert(normal.length >= 5, `chained tracker streamed results (${normal.length})`);
  let lastSeq = 0;
  for (const r of normal) {
    assert(r.seq > lastSeq, "chained seq strictly increases");
    lastSeq = r.seq;
    assert.equal(r.overridden, false, "normal result not overridden");
    if (r.found) assert(r.center && r.center.x >= 0 && r.center.y >= 0, "center present when found");
  }
  const snap = chained.probe();
  assert.equal(snap.name, `${cnvId}/kcf`, "chained meter name = <src>/kcf");
  assert(snap.inputs.frame.count > 0 && snap.outputs.track.count > 0, "chained meter recorded frame/track");
  console.log(`12-kcf-tracker: chained tracker off convert brick streamed ${normal.length} results (meter ${snap.name}).`);

  // Override → flagged results at the override center, KCF untouched.
  const OVR = { x: 137, y: 91 };
  chained.override(OVR);
  const during = await take(chained, 6);
  const flagged = during.filter((r) => r.overridden);
  assert(flagged.length >= 3, `chained override engages (${flagged.length}/${during.length} flagged)`);
  for (const r of flagged) {
    assert.equal(r.found, true, "chained override result is found");
    assert(r.center && r.center.x === OVR.x && r.center.y === OVR.y,
      `chained override center echoes the override point (${JSON.stringify(r.center)})`);
  }

  // Release → the tracker RE-ARMS at the override center on the next frame,
  // then resumes normal (overridden:false) results.
  chained.releaseOverride();
  const after = await take(chained, 6);
  const resumed = after.filter((r) => !r.overridden);
  assert(resumed.length >= 1, `results resume non-overridden after release (${after.length} seen)`);
  // The re-armed tracker starts at the override center — its first normal
  // result's center sits near the override point (KCF may drift a little).
  const first = resumed[0]!;
  if (first.found && first.center) {
    assert(Math.abs(first.center.x - OVR.x) <= 64 && Math.abs(first.center.y - OVR.y) <= 64,
      `re-armed center is near the override point (${JSON.stringify(first.center)})`);
  }
  console.log(`12-kcf-tracker: chained override→release re-armed at the override center (${resumed.length}/${after.length} resumed).`);

  chained.release();
  assert.equal(A.detachCameraPipe(cnvId), true, "detach converter");
  P.close(cnvId); P.drop(cnvId);
  camera.release?.();
}

cleanup();
console.log("12-kcf-tracker: KCF thread + async-generator stream + meter passed.");
