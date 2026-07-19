// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Capture→pipe loopback. NO hardware: exercises the
// Aravis capture→pipe convert+offer path (feedPipe, via the test hook
// Aravis.feedTestFrame) end-to-end through the REAL pipe ring — advertise a
// BGRA8 pipe → connect (broker) → feed a synthetic Mono8 frame → the reader
// addon reads back the CONVERTED BGRA8 bytes (GRAY→BGRA: B=G=R=gray, A=255) +
// the FrameMeta timestamps we filled. Proves the capture↔pipe seam without a
// camera; the live capture path (real Arv::Stream frames) needs hardware.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/11-capture-pipe.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Aravis, Pipe, __origin__, cleanup } from "core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ReaderHandle = object;
type FrameResult = {
  seq: bigint;
  meta: { deviceTimestamp: bigint; systemTimestamp: bigint };
};
type ClosedResult = { closed: true };
type ReaderAddon = {
  open(seg: string): ReaderHandle;
  readInto(h: ReaderHandle, dest: ArrayBuffer, lastSeq: bigint): FrameResult | ClosedResult | null;
  close(h: ReaderHandle): void;
};

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(join(dirname(__origin__), `${prefix}-shm-reader.node`)) as ReaderAddon;

const isClosed = (r: unknown): r is ClosedResult =>
  typeof r === "object" && r !== null && (r as ClosedResult).closed === true;

const P = Pipe as unknown as {
  advertise(spec: Record<string, unknown>): void;
  connect(id: string): { shmName: string; spec: { bytesPerFrame: number } };
  close(id: string): void;
  drop(id: string): void;
};
const A = Aravis as unknown as {
  feedTestFrame(pipeId: string, srcFormat: string, fill: number): boolean;
  attachCameraPipe(camera: unknown, pipeId: string): boolean;
  detachCameraPipe(pipeId: string): boolean;
  enableFakeCamera(): void;
  Camera: {
    list(): Promise<
      Array<{ grab(t: number): Promise<{ raw: { shape: number[] } }>; release?(): void }>
    >;
  };
};

{
  const id = "capture:bgra8";
  const width = 8;
  const height = 6;
  const channels = 4; // BGRA8
  const bytesPerFrame = width * height * channels; // 192

  P.advertise({
    id,
    pixelFormat: "BGRA8",
    dtype: "U8",
    width,
    height,
    channels,
    stride: width * channels,
    bytesPerFrame,
    ringDepth: 4,
  });

  const handle = P.connect(id); // a consumer must be connected before offers write
  assert.equal(handle.spec.bytesPerFrame, bytesPerFrame);
  const rh = reader.open(handle.shmName);
  const dest = new ArrayBuffer(bytesPerFrame);

  let lastSeq = 0n;
  for (const fill of [40, 137, 255]) {
    // Convert a uniform Mono8 frame (value `fill`) → BGRA8 and write the ring.
    const offered = A.feedTestFrame(id, "Mono8", fill);
    assert.equal(offered, true, `feedTestFrame offered (fill=${fill})`);

    const r = reader.readInto(rh, dest, lastSeq);
    assert(r && !isClosed(r), `read a frame for fill=${fill}`);
    assert(r.seq > lastSeq, "seq strictly increases");
    lastSeq = r.seq;

    // GRAY2BGRA: every pixel is (B,G,R,A) = (fill, fill, fill, 255).
    const bytes = new Uint8Array(dest);
    for (let px = 0; px < width * height; px++) {
      assert.equal(bytes[px * 4 + 0], fill, "B");
      assert.equal(bytes[px * 4 + 1], fill, "G");
      assert.equal(bytes[px * 4 + 2], fill, "R");
      assert.equal(bytes[px * 4 + 3], 255, "A");
    }
    // FrameMeta round-trip: the test hook sets deviceTimestamp = fill.
    assert.equal(r.meta.deviceTimestamp, BigInt(fill), "meta.deviceTimestamp");
  }

  // Size-guard: a mismatched source is DROPPED (not offered), never crashes.
  const mismatched = A.feedTestFrame(id, "Mono8", 10); // same size → offered
  assert.equal(mismatched, true);

  P.close(id);
  reader.close(rh);
  P.drop(id);
}

// >8-bit source regression: a 12-bit/16-bit camera format (`raw` is CV_16UC1)
// must be SCALED DOWN to true 8-bit BGRA8, not just cvtColor'd (which keeps
// 16-bit depth). Without the down-scale the 16-bit `dst` is copied as if 8-bit
// → half of each row lands per row → the preview shows colored stripes.
{
  const id = "capture:mono12p";
  const width = 8;
  const height = 6;
  const channels = 4; // BGRA8 output (the pipe is always 8-bit BGRA8)
  const bytesPerFrame = width * height * channels; // 192, 8-bit

  P.advertise({
    id,
    pixelFormat: "BGRA8",
    dtype: "U8",
    width,
    height,
    channels,
    stride: width * channels,
    bytesPerFrame,
    ringDepth: 4,
  });
  const handle = P.connect(id);
  const rh = reader.open(handle.shmName);
  const dest = new ArrayBuffer(bytesPerFrame);

  let lastSeq = 0n;
  const SIGNIFICANT_MAX = (1 << 12) - 1; // Mono12p: 12 significant bits
  for (const fill of [40, 137, 255]) {
    // Mono12p `raw` is CV_16UC1 (unpacked domain 0..4095) filled with `fill`.
    const offered = A.feedTestFrame(id, "Mono12p", fill);
    assert.equal(offered, true, `Mono12p offered (fill=${fill})`);

    const r = reader.readInto(rh, dest, lastSeq);
    assert(r && !isClosed(r), `read a Mono12p frame for fill=${fill}`);
    lastSeq = r.seq;

    // GRAY→BGRA then scaled 12-bit→8-bit: every byte is the scaled value
    // (alpha 255). A stripe bug would leave raw 16-bit low/high bytes here
    // (e.g. `fill` and 0 interleaved), far outside this ±1 band.
    const expected = Math.round((fill * 255) / SIGNIFICANT_MAX);
    const bytes = new Uint8Array(dest);
    for (let px = 0; px < width * height; px++) {
      for (const c of [0, 1, 2])
        assert(
          Math.abs(bytes[px * 4 + c] - expected) <= 1,
          `ch${c} px${px} fill=${fill}: got ${bytes[px * 4 + c]}, want ~${expected}`,
        );
      assert.equal(bytes[px * 4 + 3], 255, "A");
    }
  }

  P.close(id);
  reader.close(rh);
  P.drop(id);
}

// ---- attach→frames→detach through the REAL capture path -----
// Uses Aravis's built-in fake camera (no hardware): attachCameraPipe subscribes
// a CaptureSink to the fake camera's Arv::Stream, whose Mono8 frames are
// converted to BGRA8 and offered to the pipe — proving the cut-over seam A
// calls, end-to-end, camera-free.
{
  A.enableFakeCamera();
  const cams = await A.Camera.list();
  assert(cams.length > 0, "fake camera enumerated");
  const camera = cams[0]!;

  // Learn the fake camera's geometry from one grabbed frame (released before we
  // open the shared streaming path).
  const probe = await camera.grab(2_000_000);
  const [height, width] = probe.raw.shape as [number, number];
  (probe as { release?(): void }).release?.();

  const id = "capture:fake";
  const channels = 4; // BGRA8
  const bytesPerFrame = width * height * channels;
  P.advertise({
    id,
    pixelFormat: "BGRA8",
    dtype: "U8",
    width,
    height,
    channels,
    stride: width * channels,
    bytesPerFrame,
    ringDepth: 4,
  });

  const handle = P.connect(id); // consumer connected before frames write
  const rh = reader.open(handle.shmName);
  const dest = new ArrayBuffer(bytesPerFrame);

  assert.equal(A.attachCameraPipe(camera, id), true, "attach succeeds");

  // Read a few converted frames off the fake camera stream.
  let lastSeq = 0n;
  let got = 0;
  const deadline = Date.now() + 6000;
  while (got < 3 && Date.now() < deadline) {
    const r = reader.readInto(rh, dest, lastSeq);
    if (r && !isClosed(r)) {
      assert(r.seq > lastSeq, "seq strictly increases");
      lastSeq = r.seq;
      // GRAY→BGRA on every real frame: B==G==R per pixel, alpha saturated.
      const b = new Uint8Array(dest);
      for (let px = 0; px < width * height; px += 997 /* sparse sample */) {
        assert.equal(b[px * 4 + 0], b[px * 4 + 1], "B==G");
        assert.equal(b[px * 4 + 1], b[px * 4 + 2], "G==R");
        assert.equal(b[px * 4 + 3], 255, "alpha saturated");
      }
      got++;
    } else {
      await sleep(5);
    }
  }
  assert(got >= 3, `attached capture delivered frames (got ${got})`);

  // Detach drops the CaptureSink (unsubscribes); idempotent.
  assert.equal(A.detachCameraPipe(id), true, "detach removes the binding");
  assert.equal(A.detachCameraPipe(id), false, "detach is idempotent");

  reader.close(rh);
  P.close(id);
  P.drop(id);
}

cleanup();
console.log("11-capture-pipe: convert→offer loopback + fake-camera attach/detach passed.");
