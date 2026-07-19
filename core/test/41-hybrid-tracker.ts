// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Higher-FPS HYBRID tracker: a drop-in replacement for the KCF
// tracker node — windowed NCC + dual anchor/adaptive template + expanding
// ANCHOR re-detection recovery. Same handle API / TrackResult schema / meter
// schema / threading model as the KCF tracker, so this test is test 12's
// harness re-pointed at createHybridTracker / createChainedHybridTracker.
//
// PLUMBING + PARITY only. Tracking QUALITY (found ratio, center accuracy, µs,
// recovery) is benchmarked in the pure C++ probe — the Aravis fake camera's
// ramp is SPATIALLY PERIODIC and gives chaotic correlation-tracker verdicts,
// so quality MUST NOT be asserted on it. Here we prove:
// the thread + async-generator seam + meter schema, override/release re-arm
// parity, and stall→drop metering — identical to the KCF path.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/41-hybrid-tracker.ts

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
  createHybridTracker(camera: unknown, name?: string): Tracker;
  createChainedHybridTracker(sourcePipeId: string, name?: string): Tracker;
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

// --- RAW hybrid tracker on the camera stream --------------------------------
{
  A.enableFakeCamera();
  const cams = await A.Camera.list();
  assert(cams.length > 0, "fake camera enumerated");
  const camera = cams[0]!;
  const probe = await camera.grab(2_000_000);
  const [height, width] = probe.raw.shape as [number, number];

  const tracker = T.createHybridTracker(camera);
  tracker.arm({ x: Math.floor(width / 3), y: Math.floor(height / 3), width: 96, height: 96 });

  const results: Result[] = [];
  const deadline = Date.now() + 8000;
  for await (const r of tracker as AsyncIterable<Result>) {
    results.push(r);
    if (results.length >= 25 || Date.now() > deadline) break;
  }

  // The hybrid thread produced a result STREAM off the JS loop (async
  // generator), each with a monotonic seq and an in-bounds bbox when found.
  assert(results.length >= 5, `hybrid streamed results (got ${results.length})`);
  let lastSeq = 0;
  let found = 0;
  for (const r of results) {
    assert(r.seq > lastSeq, "seq strictly increases");
    lastSeq = r.seq;
    assert(typeof r.found === "boolean", "found flag present");
    if (r.found) {
      found++;
      const b = r.bbox!;
      assert(b.x < width && b.y < height, "bbox origin in-bounds");
      assert(r.center && Number.isFinite(r.center.x) && Number.isFinite(r.center.y),
        "sub-pixel center present when found");
    }
  }
  // Tracking ENGAGED through the pipe (the engine ran and locked on ≥1 frame);
  // sustained quality is probe-gated (periodic fake-camera content).
  assert(found >= 1, `hybrid engine locked at least once (${found}/${results.length})`);

  // Meter schema — IDENTICAL to the KCF tracker (frame input / track output,
  // metered intervals + drops). The graph badges + trackerWorkload() adapter
  // consume exactly this shape.
  const snap = tracker.probe();
  assert.equal(snap.name, "tracker:center", "default meter name matches KCF drop-in");
  assert(snap.inputs.frame && snap.inputs.frame.count > 0, "frames ingested");
  assert(snap.outputs.track && snap.outputs.track.count > 0, "tracks emitted");
  assert(snap.inputs.frame.maxIntervalMs > 0, "frame interval metered");
  assert(snap.busyMs >= 0, "busy time metered");
  assert.equal(snap.dropTotal, 0, "no drops while the tracker keeps up");
  console.log(
    `41-hybrid-tracker: raw results=${results.length} found=${found} frames=${snap.inputs.frame.count} ` +
      `tracks=${snap.outputs.track.count} busyMs=${snap.busyMs.toFixed(1)} ` +
      `maxIntervalMs=${snap.inputs.frame.maxIntervalMs.toFixed(1)} drops=${snap.dropTotal}`,
  );

  // Stall → the camera outruns the transform, latest-wins overwrites, drops climb.
  tracker.stall(120);
  const before = tracker.probe().dropTotal;
  const stallDeadline = Date.now() + 8000;
  let consumed = 0;
  for await (const _r of tracker as AsyncIterable<Result>) {
    if (++consumed >= 6 || Date.now() > stallDeadline) break;
  }
  const after = tracker.probe();
  assert(after.dropTotal > before, `drops climb under stall (${before} → ${after.dropTotal})`);
  assert(after.busyMs > 0, "busy time metered under stall");
  console.log(`41-hybrid-tracker: stalled drops ${before} → ${after.dropTotal} (busyMs=${after.busyMs.toFixed(1)}).`);

  // Override parity — engaged results carry the override center + overridden:true,
  // engine NOT consulted (identical to the KCF state machine, which is reused).
  tracker.stall(0);
  const OVR = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  tracker.override(OVR);
  const overrid = await take(tracker, 8);
  const flagged = overrid.filter((r) => r.overridden);
  assert(flagged.length >= 3, `override engages (${flagged.length}/${overrid.length} flagged)`);
  for (const r of flagged) {
    assert.equal(r.found, true, "raw override result is found");
    assert(r.center && r.center.x === OVR.x && r.center.y === OVR.y,
      `raw override center echoes the override point (${JSON.stringify(r.center)})`);
  }
  console.log(`41-hybrid-tracker: raw override emits ${flagged.length} flagged results at the override center.`);
  tracker.release();
}

// --- CHAINED hybrid tracker on a convert brick + override/release re-arm -----
{
  const cams = await A.Camera.list();
  const camera = cams[0]!;
  const probe = await camera.grab(2_000_000);
  const [height, width] = probe.raw.shape as [number, number];
  const serial = String(camera.serial ?? "0");

  const cnvId = `camera/${serial}/convert`;
  P.advertise({
    id: cnvId, pixelFormat: "BGRA8", dtype: "U8", width, height,
    channels: 4, stride: width * 4, bytesPerFrame: width * height * 4, ringDepth: 4,
  });
  assert.equal(A.attachCameraPipe(camera, cnvId), true, "converter attaches");

  const chained = T.createChainedHybridTracker(cnvId);
  assert.equal(P.consumers(cnvId), 0, "convert pipe has no SHM consumers (tap-only demand)");
  chained.arm({ x: Math.floor(width / 3), y: Math.floor(height / 3), width: 96, height: 96 });

  const normal = await take(chained, 5);
  assert(normal.length >= 5, `chained hybrid streamed results (${normal.length})`);
  let lastSeq = 0;
  for (const r of normal) {
    assert(r.seq > lastSeq, "chained seq strictly increases");
    lastSeq = r.seq;
    assert.equal(r.overridden, false, "normal result not overridden");
    if (r.found) assert(r.center && Number.isFinite(r.center.x), "center present when found");
  }
  const snap = chained.probe();
  assert.equal(snap.name, `${cnvId}/hybrid`, "chained meter name = <src>/hybrid");
  assert(snap.inputs.frame.count > 0 && snap.outputs.track.count > 0, "chained meter recorded frame/track");
  console.log(`41-hybrid-tracker: chained tracker off convert brick streamed ${normal.length} results (meter ${snap.name}).`);

  // Override → flagged results at the override center, engine untouched.
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

  // Release → the tracker RE-ARMS at the override center on the next frame, then
  // resumes normal (overridden:false) results. (Re-armed center accuracy is NOT
  // asserted here — periodic fake-camera content; probe covers re-lock quality.)
  chained.releaseOverride();
  const after = await take(chained, 6);
  const resumed = after.filter((r) => !r.overridden);
  assert(resumed.length >= 1, `results resume non-overridden after release (${after.length} seen)`);
  console.log(`41-hybrid-tracker: chained override→release re-armed (${resumed.length}/${after.length} resumed).`);

  chained.release();
  assert.equal(A.detachCameraPipe(cnvId), true, "detach converter");
  P.close(cnvId); P.drop(cnvId);
  camera.release?.();
}

cleanup();
console.log("41-hybrid-tracker: hybrid thread + async-generator stream + meter + override parity passed.");
