// A-30 fire-and-forget streaming actuation. Two concerns:
//  (1) `Controller.predictVolts` reproduces the awaited `actuate()` ACK-readback
//      math exactly (given the firmware echoes commanded channels — RIG-VERIFY
//      the echo assumption on hardware).
//  (2) `startActuationLoop`'s stream lifecycle: open a CMD_STREAM on start,
//      fire-and-forget `update()` per tick, close on stop, reopen on a
//      controller reconnect, and fall back to awaited `actuate()` on v1.
// A fake `Device` (echoing) backs (1); fake controllers via `setActiveController`
// back (2) — no serial hardware.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("core/Controller", () => {
  class FakeDevice {
    connected = true;
    v2Capable = true;
    stats = {};
    constructor(_path: string) {
      void _path;
    }
    verifyVersion = vi.fn(async () => {});
    release = vi.fn();
    fireAndForget = vi.fn();
    get = vi.fn();
    // Echoes the commanded channels back (the A-30 Q1 assumption), so the
    // readback decode and `predictVolts` must agree.
    set = vi.fn(async (prop: string, arg: { left?: number[]; right?: number[] }) => {
      if (prop === "Actuate")
        return { left: arg.left, right: arg.right, complete_time: 0 };
      if (prop === "Bias") return 200;
      return true;
    });
  }
  const Protocol = {
    System: { Enable: "Enable", Info: "Info", Version: "Version" },
    Config: { Log: "Log", LPF: "LPF", Bias: "Bias" },
    Command: {
      Actuate: "Actuate",
      Trigger: "Trigger",
      MirrorStream: "MirrorStream",
      Frame: "Frame",
    },
  };
  return { Device: FakeDevice, Protocol };
});
vi.mock("serialport", () => ({ SerialPort: { list: vi.fn(async () => []) } }));

import {
  Controller,
  setActiveController,
  type StreamHandle,
} from "@orchestrator/controller";
import { startActuationLoop } from "@orchestrator/actuation";

type Pos = { x: number; y: number };

describe("Controller.predictVolts (A-30)", () => {
  it("equals the awaited actuate() readback decode (firmware echoes channels)", async () => {
    const ctrl = new Controller({ path: "/dev/predict" } as never);
    await ctrl.ready;
    const pos = { left: { x: 1.5, y: -2.3 }, right: { x: 0.7, y: 4.1 } };

    const readback = await ctrl.actuate(pos);
    const predicted = ctrl.predictVolts(pos);

    expect(predicted.left).toEqual({ x: readback.left.x, y: readback.left.y });
    expect(predicted.right).toEqual({ x: readback.right.x, y: readback.right.y });
    ctrl.release();
  });
});

// A fake controller with just the surface `startActuationLoop` touches.
function makeFakeController(v2 = true) {
  const handle: StreamHandle & { update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } = {
    id: 0,
    update: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const c = {
    v2Capable: v2,
    enabled: false,
    enable: vi.fn(async () => {
      c.enabled = true;
    }),
    disable: vi.fn(async () => {
      c.enabled = false;
    }),
    createStream: vi.fn(async () => handle),
    predictVolts: vi.fn((p: { left: Pos; right: Pos }) => ({ left: p.left, right: p.right })),
    actuate: vi.fn(async (p: { left: Pos; right: Pos }) => ({ ...p, completeTime: 0 })),
    handle,
  };
  return c;
}

const asController = (c: ReturnType<typeof makeFakeController>) =>
  setActiveController(c as never);

describe("startActuationLoop stream lifecycle (A-30)", () => {
  afterEach(() => {
    setActiveController(null);
    vi.useRealTimers();
  });

  it("opens the stream on start, streams updates, closes on stop", async () => {
    vi.useFakeTimers();
    const c = makeFakeController(true);
    asController(c);
    const onVolts = vi.fn();
    const loop = startActuationLoop({
      targetVolts: () => ({ l: { x: 1, y: 1 }, r: { x: 2, y: 2 } }),
      onVolts,
      intervalMs: 1,
    });

    await vi.advanceTimersByTimeAsync(5);
    expect(c.createStream).toHaveBeenCalledTimes(1); // opened once on start
    expect(c.handle.update).toHaveBeenCalled(); // subsequent ticks stream
    // onVolts got the LOCAL prediction + ~0 RTT.
    expect(onVolts).toHaveBeenCalledWith({ L: { x: 1, y: 1 }, R: { x: 2, y: 2 } }, 0);

    loop.stop();
    await vi.advanceTimersByTimeAsync(5);
    expect(c.handle.close).toHaveBeenCalledTimes(1); // closed on stop
    expect(c.disable).toHaveBeenCalled(); // disabled iff loop enabled it
  });

  it("reopens the stream on a controller reconnect", async () => {
    vi.useFakeTimers();
    const c1 = makeFakeController(true);
    asController(c1);
    const loop = startActuationLoop({
      targetVolts: () => ({ l: { x: 0, y: 0 }, r: { x: 0, y: 0 } }),
      onVolts: vi.fn(),
      intervalMs: 1,
    });
    await vi.advanceTimersByTimeAsync(3);
    expect(c1.createStream).toHaveBeenCalledTimes(1);

    const c2 = makeFakeController(true); // fresh instance = reconnect
    asController(c2);
    await vi.advanceTimersByTimeAsync(3);
    expect(c1.handle.close).toHaveBeenCalledTimes(1); // stale handle dropped
    expect(c2.createStream).toHaveBeenCalledTimes(1); // reopened on new controller

    loop.stop();
    await vi.advanceTimersByTimeAsync(3);
  });

  it("falls back to awaited actuate() on v1 firmware (no stream)", async () => {
    vi.useFakeTimers();
    const c = makeFakeController(false); // v1: not v2Capable
    asController(c);
    const loop = startActuationLoop({
      targetVolts: () => ({ l: { x: 1, y: 1 }, r: { x: 2, y: 2 } }),
      onVolts: vi.fn(),
      intervalMs: 1,
    });
    await vi.advanceTimersByTimeAsync(3);
    expect(c.createStream).not.toHaveBeenCalled();
    expect(c.actuate).toHaveBeenCalled();

    loop.stop();
    await vi.advanceTimersByTimeAsync(3);
  });
});
