// manual-control's capture queue + the V1 regression (docs/history/refactor/
// orchestrator.md §6/§7.1 item 2, fourth target): idle-during-a-busy-capture
// must defer camera-lease release until the capture actually drains, not
// release them out from under an in-flight `stack()` read of the raw
// camera stream. `capture.ts` is a pure factory over a `CaptureDeps`
// interface, so it's testable in complete isolation from the real registry/
// controller/core — no session, no Hub, no native addon involved.
//
// `core/Vision`'s ops and `@lib/imgproc`'s `stack` are native-backed (or
// depend on real camera streams) — mocked to trivial pass-throughs so this
// test exercises the *orchestration* (timing of `waitIdle()` vs. an
// in-flight `run()`), not image processing correctness.

import { describe, expect, it, vi } from "vitest";
import { flush } from "./fake-endpoint";

const { fakeMat } = vi.hoisted(() => {
  function fakeMat(shape: number[] = [2, 2], channels = 4) {
    const len = shape.reduce((a, b) => a * b, 1) * channels;
    return Object.assign(new Uint8Array(len), { shape, channels });
  }
  return { fakeMat };
});

vi.mock("core/Vision", () => ({
  convertType: vi.fn(() => fakeMat()),
  cvtColor: vi.fn(() => fakeMat()),
  diff: vi.fn(() => fakeMat()),
  slice: vi.fn(() => fakeMat()),
  wrapPerspective: vi.fn(() => fakeMat()),
}));
vi.mock("@lib/imgproc", () => ({
  stack: vi.fn(async () => ({ image: fakeMat([2, 2], 1), format: "Mono8" })),
  makeBGRA: vi.fn(() => fakeMat()),
}));
vi.mock("core", () => ({
  Vision: { save: vi.fn(async () => true) },
}));

import { createCapture, type CaptureDeps } from "@modules/manual-control/capture";

function stubDeps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  const undistort = {
    sensor_size: { width: 100, height: 100 },
    focal: { x: 1, y: 1 },
    center: { x: 50, y: 50 },
    fov: { x: 1, y: 1 },
    position: (pts: unknown[]) => pts.map(() => ({ x: 50, y: 50 })),
  } as any;
  const conv = {
    V2A: { L: () => ({ x: 0, y: 0 }), R: () => ({ x: 0, y: 0 }) },
    A2H: { L: () => fakeMat([3, 3], 1), R: () => fakeMat([3, 3], 1) },
  } as any;
  const leases = {
    L: { camera: { stream: [] } },
    R: { camera: { stream: [] } },
    C: { camera: { stream: [] } },
  } as any;
  return {
    getTriple: () => ({ leases, conv, undistort }) as any,
    volts: () => ({ L: { x: 0, y: 0 }, R: { x: 0, y: 0 } }),
    targetAngle: () => ({ x: 0, y: 0 }),
    centerFrameSize: () => ({ width: 100, height: 100 }),
    zoom: () => 1,
    capStack: () => 1,
    baseline: () => 200,
    steerToAngle: () => {},
    // C-23: the one-shot undistort-pipe read (was the onCenterTick feed).
    readCenter: async () => fakeMat([4, 4], 4) as any,
    frame: () => {},
    telemetry: () => {},
    ...overrides,
  };
}

/** A `readCenter` the test unblocks manually — stands in for "the next center
 *  frame arrives on the pipe" (was `capture.onCenterTick(...)`). */
function deferredCenter() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const readCenter = async () => {
    await gate;
    return fakeMat([4, 4], 4) as any;
  };
  return { readCenter, release: () => release() };
}

describe("manual-control capture — V1 regression", () => {
  it("waitIdle() resolves immediately when no capture is in flight", async () => {
    const capture = createCapture(stubDeps());
    await expect(capture.waitIdle()).resolves.toBeUndefined();
  });

  it("waitIdle() stays pending while a capture is blocked on the next center frame", async () => {
    const center = deferredCenter();
    const capture = createCapture(stubDeps({ readCenter: center.readCenter }));

    const runPromise = capture.run([]); // no setpoints -> single pass
    await flush();

    let idleResolved = false;
    const idlePromise = capture.waitIdle().then(() => {
      idleResolved = true;
    });
    await flush();
    await flush();
    // The capture hasn't received its center frame yet — it's still inside
    // `captureOnce`'s `await requestCenterView()` (C-23: a one-shot pipe read).
    // Resolving idle now (i.e. the old, buggy `idleSession` that released
    // leases unconditionally) would be exactly V1: the camera gets released
    // while `stack()` below is about to read from it.
    expect(idleResolved).toBe(false);

    // Unblock the capture — the next center frame lands on the pipe.
    center.release();

    await runPromise;
    await idlePromise;
    expect(idleResolved).toBe(true);
  });

  it("a second run() call while one is in flight is a no-op that returns the same in-flight promise", async () => {
    const center = deferredCenter();
    const capture = createCapture(stubDeps({ readCenter: center.readCenter }));
    const first = capture.run([]);
    const second = capture.run([]); // should not start a second pass
    expect(second).toBe(first);
    center.release();
    await first;
  });

  it("discard() clears pending capture state without needing an in-flight run", () => {
    const telemetry = vi.fn();
    const capture = createCapture(stubDeps({ telemetry }));
    capture.discard();
    expect(telemetry).toHaveBeenCalledWith({ capture_meta: {} });
  });
});
