// Exiting manual-control → the next activation
// reopened a serial whose OLD handle was still mid-release. In-process that
// reopen "succeeds" onto a still-streaming device (unlike the cross-process
// RT1 race, where the open itself fails), and every config write then bounces
// off TLParamsLocked with USB3Vision access-denied — the L/R pixel-format
// restore failures in the field log. Two fixes pinned here:
//  1. `acquire()`/`acquireMany()` await the serial's pending close before
//     opening a fresh handle (`closingBySerial`).
//  2. `applyStoredConfig` retries across the acquisition-stop window (the old
//     stream thread stops acquisition asynchronously even after the JS-side
//     release settles) instead of continuing half-configured.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

describe("registry reopen-while-closing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@orchestrator/store", () => ({
      read: vi.fn(async (_path: string[], fallback: unknown) => fallback),
    }));
    vi.doMock("@orchestrator/store-hub", () => ({
      read: vi.fn(async (_path: string[], fallback: unknown) => fallback),
    }));
  });

  it("acquire() waits for the previous handle's close before reopening", async () => {
    let resolveRelease!: () => void;
    const releaseGate = new Promise<void>((r) => (resolveRelease = r));
    const makeCamera = () => ({
      serial: "SN1",
      model: "M",
      vendor: "V",
      // First handle's release hangs until the test lets it settle —
      // modelling the native close still in flight.
      release: vi.fn(() => releaseGate),
    });
    const list = vi.fn(async () => [makeCamera()]);
    vi.doMock("core/Aravis", () => ({ Camera: { list } }));

    const { acquire } = await import("@orchestrator/registry");
    const lease = await acquire("SN1");
    expect(lease).not.toBeNull();
    expect(list).toHaveBeenCalledTimes(1);

    lease!.release(); // refs -> 0: close starts, but its release() is gated

    let reopened = false;
    const second = acquire("SN1").then((l) => {
      reopened = true;
      return l;
    });
    // Give the reopen every chance to (incorrectly) run ahead of the close.
    await new Promise((r) => setTimeout(r, 20));
    expect(reopened).toBe(false);
    expect(list).toHaveBeenCalledTimes(1); // no second discovery pass yet

    resolveRelease();
    const lease2 = await second;
    expect(lease2).not.toBeNull();
    expect(list).toHaveBeenCalledTimes(2); // reopened only after close settled
  });

  it("applyStoredConfig retries pixel-format restore across a transient device lock", async () => {
    vi.useFakeTimers();
    vi.doMock("@orchestrator/store-hub", () => ({
      read: vi.fn(async () => ({ pixel_format: "BayerRG12p" })),
    }));

    // Rejects writes (still "streaming") for the first two attempts — the
    // access-denied window while the old handle's acquisition stop lands.
    let fmt = "Mono8";
    let denials = 2;
    const camera = {
      serial: "SN1",
      model: "M",
      vendor: "V",
      get pixel_format() {
        return fmt;
      },
      set pixel_format(v: string) {
        if (denials > 0) {
          denials--;
          throw new Error("USB3Vision write_memory error (access-denied)");
        }
        fmt = v;
      },
    };

    const { applyStoredConfig } = await import("@orchestrator/camera");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const applied = applyStoredConfig(camera as never);
      await vi.advanceTimersByTimeAsync(2000);
      await applied;
      expect(fmt).toBe("BayerRG12p");
      expect(denials).toBe(0); // actually exercised the retry path
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.doUnmock("core/Aravis");
  vi.doUnmock("@orchestrator/store");
  vi.doUnmock("@orchestrator/store-hub");
});
