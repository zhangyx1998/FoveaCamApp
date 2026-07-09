// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Unit tests for the shared CAPTURE helper (capture-recorder-everywhere ruling
// 3): the command round-trip + telemetry, the recording-vs-capture exclusivity
// refusal, the "not ready" degradation, the burst-timeout rejection pass-through
// (captureBusy always resets), and the extracted ON-DEMAND acquire sequence with
// its reverse-order error unwind. A FAKE capture node (via the `createNode` seam)
// stands in for the worker; the acquire logic is driven with fake broker /
// rawPipes so no native core loads.

import { describe, it, expect, vi } from "vitest";
import {
  createCaptureHelper,
  type CaptureHelperDeps,
} from "@orchestrator/capture-helper";
import type {
  CaptureNodeHandle,
  CaptureNodeOptions,
  CaptureShot,
  AcquireStreams,
} from "@orchestrator/capture-node";
import type { Serializable } from "@lib/orchestrator/protocol";

// --- fakes ------------------------------------------------------------------

function fakeSnapshot(reset: boolean, indexed: boolean): CaptureShot {
  return {
    reset,
    indexed,
    stackCount: 3,
    H_L: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    H_R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    rect: { x: 0, y: 0, width: 10, height: 10 },
    meta: { fovea: {}, left: {}, right: {} },
  };
}

const CENTER = { shmName: "center-shm", maxBytes: 400, channels: 4 };
const CAMERAS = {
  left: { serial: "L1", pixel_format: "Mono8", getFeatureInt: () => 4 },
  right: { serial: "R1", pixel_format: "Mono8", getFeatureInt: () => 4 },
};

/** A fake capture node whose `capture` resolves a manifest (or rejects, to
 *  simulate the F1 burst timeout). Records the acquireStreams the helper wired
 *  so a test can drive the extracted on-demand connect/release logic. */
function fakeNode(opts: {
  capture?: (shot: CaptureShot) => Promise<Record<string, Serializable>>;
}) {
  const shots: CaptureShot[] = [];
  let acquireStreams: AcquireStreams | null = null;
  const handle: CaptureNodeHandle = {
    id: "capture/test",
    capture: vi.fn(async (shot: CaptureShot) => {
      shots.push(shot);
      return opts.capture
        ? opts.capture(shot)
        : ({ fovea: {}, left: {}, right: {} } as Record<string, Serializable>);
    }),
    getPreview: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const createNode = (options: CaptureNodeOptions): CaptureNodeHandle => {
    acquireStreams = options.acquireStreams;
    return handle;
  };
  return {
    handle,
    shots,
    createNode,
    get acquireStreams() {
      return acquireStreams;
    },
  };
}

function makeHelper(over: Partial<CaptureHelperDeps> = {}) {
  const telemetry = vi.fn();
  const node = fakeNode({});
  let recording = false;
  const deps: CaptureHelperDeps = {
    id: "capture/test",
    broker: { connect: vi.fn(), disconnect: vi.fn() } as never,
    rawPipes: { acquire: vi.fn(), refCount: () => 0, specOf: () => undefined } as never,
    graphInputs: { left: "camera/L1/raw", right: "camera/R1/raw", center: "undistort/C1" },
    cameras: () => CAMERAS,
    centerPipe: () => CENTER,
    snapshot: (reset, indexed) => fakeSnapshot(reset, indexed),
    recordingActive: () => recording,
    telemetry,
    createNode: node.createNode,
    ...over,
  };
  const helper = createCaptureHelper(deps);
  return {
    helper,
    telemetry,
    node,
    setRecording: (v: boolean) => (recording = v),
  };
}

// --- tests ------------------------------------------------------------------

describe("captureShot", () => {
  it("builds the snapshot, forwards to the node, and toggles captureBusy + capture_meta", async () => {
    const { helper, telemetry, node } = makeHelper();
    helper.build();
    await helper.captureShot(); // fresh (unindexed)
    expect(node.shots).toHaveLength(1);
    expect(node.shots[0]).toMatchObject({ reset: true, indexed: false });
    expect(helper.capturing).toBe(false); // settled
    // captureBusy true then false; capture_meta published with the manifest.
    expect(telemetry).toHaveBeenCalledWith({ captureBusy: true });
    expect(telemetry).toHaveBeenCalledWith({ captureBusy: false });
    expect(telemetry).toHaveBeenCalledWith({
      capture_meta: { fovea: {}, left: {}, right: {} },
    });
  });

  it("treats a present tag as an indexed (raster) accumulation", async () => {
    const { helper, node } = makeHelper();
    helper.build();
    await helper.captureShot(2);
    expect(node.shots[0]).toMatchObject({ reset: false, indexed: true });
    // tag === 0 starts a FRESH accumulation but is still indexed (raster) — the
    // first raster shot (matches manual-control's original semantics).
    await helper.captureShot(0);
    expect(node.shots[1]).toMatchObject({ reset: true, indexed: true });
    // absent tag → a fresh UN-indexed (single-shot) capture.
    await helper.captureShot();
    expect(node.shots[2]).toMatchObject({ reset: true, indexed: false });
  });

  it("refuses while a recording is active (exclusivity, ruling 6) — never touches the node", async () => {
    const { helper, node, setRecording } = makeHelper();
    helper.build();
    setRecording(true);
    await expect(helper.captureShot()).rejects.toThrow(/recording is active/);
    expect(node.handle.capture).not.toHaveBeenCalled();
    expect(helper.capturing).toBe(false);
  });

  it("rejects Capture not ready when the snapshot degrades to null (no undistort)", async () => {
    const { helper, node } = makeHelper({ snapshot: () => null });
    helper.build();
    await expect(helper.captureShot()).rejects.toThrow(/not ready/i);
    expect(node.handle.capture).not.toHaveBeenCalled();
  });

  it("rejects before build (no node yet)", async () => {
    const { helper } = makeHelper();
    await expect(helper.captureShot()).rejects.toThrow(/not ready/i);
  });

  it("passes a burst-timeout rejection through and still clears captureBusy", async () => {
    const err = new Error("capture burst timed out after 10000ms: left delivered 0/3");
    const node = fakeNode({ capture: () => Promise.reject(err) });
    const { helper, telemetry } = makeHelper({ createNode: node.createNode });
    helper.build();
    await expect(helper.captureShot()).rejects.toThrow(/timed out/);
    expect(helper.capturing).toBe(false);
    expect(telemetry).toHaveBeenLastCalledWith({ captureBusy: false });
  });
});

describe("getPreview / save / discard", () => {
  it("forwards getPreview to the node; null before build", async () => {
    const { helper, node } = makeHelper();
    expect(await helper.getPreview("left")).toBeNull(); // not built
    helper.build();
    await helper.getPreview("left", 1);
    expect(node.handle.getPreview).toHaveBeenCalledWith("left", 1);
  });

  it("save/discard forward to the node and clear capture_meta", async () => {
    const { helper, telemetry, node } = makeHelper();
    helper.build();
    await helper.save("/tmp/x", "png");
    expect(node.handle.save).toHaveBeenCalledWith("/tmp/x", "png");
    expect(telemetry).toHaveBeenLastCalledWith({ capture_meta: {} });
    await helper.discard();
    expect(node.handle.discard).toHaveBeenCalled();
    expect(telemetry).toHaveBeenLastCalledWith({ capture_meta: {} });
  });
});

describe("on-demand acquireStreams (extracted verbatim from manual-control)", () => {
  it("advertises + connects L/R, rides the center pipe, and release()s in order", () => {
    const acquireL = { pipeId: "camera/L1/raw", release: vi.fn() };
    const acquireR = { pipeId: "camera/R1/raw", release: vi.fn() };
    const acquire = vi
      .fn()
      .mockReturnValueOnce(acquireL)
      .mockReturnValueOnce(acquireR);
    const connect = vi.fn((pipeId: string) => ({
      shmName: `${pipeId}-shm`,
      spec: { pixelFormat: "Mono8", dtype: "U8", channels: 1, bytesPerFrame: 16, maxBytes: 16 },
    }));
    const disconnect = vi.fn();
    // Build with the instrumented broker/rawPipes so we can grab the real
    // acquireStreams the helper wired into the node.
    const nodeRef = fakeNode({});
    const helper = createCaptureHelper({
      id: "capture/test",
      broker: { connect, disconnect } as never,
      rawPipes: { acquire, refCount: () => 0, specOf: () => undefined } as never,
      graphInputs: { left: "camera/L1/raw", right: "camera/R1/raw", center: "undistort/C1" },
      cameras: () => CAMERAS,
      centerPipe: () => CENTER,
      snapshot: fakeSnapshot,
      recordingActive: () => false,
      telemetry: vi.fn(),
      createNode: nodeRef.createNode,
    });
    helper.build();
    const acq = nodeRef.acquireStreams!();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledWith("camera/L1/raw");
    expect(connect).toHaveBeenCalledWith("camera/R1/raw");
    expect(acq.streams.center.shmName).toBe("center-shm");
    // release disconnects both then releases both.
    acq.release();
    expect(disconnect).toHaveBeenCalledWith("camera/L1/raw");
    expect(disconnect).toHaveBeenCalledWith("camera/R1/raw");
    expect(acquireL.release).toHaveBeenCalled();
    expect(acquireR.release).toHaveBeenCalled();
  });

  it("unwinds in REVERSE on a mid-sequence throw (no orphaned refcount)", () => {
    const acquireL = { pipeId: "camera/L1/raw", release: vi.fn() };
    const acquireR = { pipeId: "camera/R1/raw", release: vi.fn() };
    const acquire = vi
      .fn()
      .mockReturnValueOnce(acquireL)
      .mockReturnValueOnce(acquireR);
    // Second connect (right) throws → left connect must be undone, both released.
    const connect = vi
      .fn()
      .mockReturnValueOnce({
        shmName: "L-shm",
        spec: { pixelFormat: "Mono8", dtype: "U8", channels: 1, bytesPerFrame: 16 },
      })
      .mockImplementationOnce(() => {
        throw new Error("connect failed");
      });
    const disconnect = vi.fn();
    const nodeRef = fakeNode({});
    const helper = createCaptureHelper({
      id: "capture/test",
      broker: { connect, disconnect } as never,
      rawPipes: { acquire, refCount: () => 0, specOf: () => undefined } as never,
      graphInputs: { left: "camera/L1/raw", right: "camera/R1/raw", center: "undistort/C1" },
      cameras: () => CAMERAS,
      centerPipe: () => CENTER,
      snapshot: fakeSnapshot,
      recordingActive: () => false,
      telemetry: vi.fn(),
      createNode: nodeRef.createNode,
    });
    helper.build();
    expect(() => nodeRef.acquireStreams!()).toThrow(/connect failed/);
    // Left was connected → disconnected on unwind; both acquisitions released.
    expect(disconnect).toHaveBeenCalledWith("camera/L1/raw");
    expect(acquireL.release).toHaveBeenCalled();
    expect(acquireR.release).toHaveBeenCalled();
  });
});
