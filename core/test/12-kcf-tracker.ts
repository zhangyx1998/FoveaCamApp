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
  Camera: { list(): Promise<Array<{ grab(t: number): Promise<{ raw: { shape: number[] } }> }>> };
};
const T = (await import("core")).Tracker as unknown as {
  createTracker(camera: unknown): {
    arm(roi: { x: number; y: number; width: number; height: number }): void;
    probe(): Snapshot;
    stall(ms: number): void;
    release(): void;
    [Symbol.asyncIterator](): AsyncIterator<Result>;
  };
};

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
    if (results.length >= 5 || Date.now() > deadline) break;
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

  // Meter recorded the workload: frames ingested, tracks emitted, and frame
  // INTERVALS (maxIntervalMs > 0). Drops = camera frames the KCF thread couldn't
  // keep up with (latest-wins overwrites) — the load-bearing "can't keep up"
  // signal; present (>=0), and reported here.
  const snap = tracker.probe();
  assert.equal(snap.name, "tracker:center");
  assert(snap.inputs.frame && snap.inputs.frame.count > 0, "frames ingested");
  assert(snap.outputs.track && snap.outputs.track.count > 0, "tracks emitted");
  assert(snap.inputs.frame.maxIntervalMs > 0, "frame interval metered");
  assert(snap.busyMs > 0, "KCF busy time metered");
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
  console.log(
    `12-kcf-tracker: stalled drops ${before} → ${after.dropTotal} ` +
      `(busyMs=${after.busyMs.toFixed(1)})`,
  );

  tracker.release();
}

cleanup();
console.log("12-kcf-tracker: KCF thread + async-generator stream + meter passed.");
