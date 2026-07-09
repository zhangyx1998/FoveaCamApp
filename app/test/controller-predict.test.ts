// A-30 local volt prediction — ported from the deleted actuation-stream.test.ts
// (its `startActuationLoop` lifecycle half is fully covered by
// controller-node.test.ts; this assertion is the surviving unique piece).
// `Controller.predictVolts` must reproduce the awaited `actuate()` ACK-readback
// math exactly (given the firmware echoes commanded channels — RIG-VERIFY the
// echo assumption on hardware): the controller NODE's streaming path publishes
// this prediction as telemetry / mirror-history trajectory in place of the
// readback the fire-and-forget protocol has no response for.

import { describe, expect, it, vi } from "vitest";

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

import { Controller } from "@orchestrator/controller";

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

  it("applyStreamedPos mirrors the streamed target into `pos` (local only)", async () => {
    const ctrl = new Controller({ path: "/dev/predict" } as never);
    await ctrl.ready;
    const predicted = ctrl.predictVolts({
      left: { x: 3, y: -1 },
      right: { x: -2, y: 4 },
    });

    ctrl.applyStreamedPos(predicted);
    expect(ctrl.pos.left).toEqual(predicted.left);
    expect(ctrl.pos.right).toEqual(predicted.right);
    ctrl.release();
  });
});
