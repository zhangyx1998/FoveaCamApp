// Controller serial WRITE meter. Verifies the `controller:<port>`
// workload registers, `emit`s one `packets` output on every packet pushed to
// the wire (awaited config/actuate sends AND the fire-and-forget stream update
// hot path), and disposes on `release()` — so the serial send rate becomes a
// first-class `perfSnapshot.workloads` row the profiler can surface. Uses a
// fake `Device` so no serial hardware is opened.

import { afterEach, describe, expect, it, vi } from "vitest";

// Defined INSIDE the factory: `vi.mock` is hoisted above the file body, so it
// cannot close over top-level declarations.
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
    get = vi.fn(async (prop: string) => {
      // System.Timestamp decodes to a frozen BigInt wrapper object (the
      // native PacketInstance shape) — readTimestamp() unwraps it via
      // .valueOf() into the primitive µs bigint.
      if (prop === "Timestamp") return Object(123_456_789n);
      return undefined;
    });
    set = vi.fn(async (prop: string) => {
      if (prop === "Actuate")
        return { left: [0, 0, 0, 0], right: [0, 0, 0, 0], complete_time: 0 };
      if (prop === "Bias") return 200; // setBias reads a numeric DAC value back
      if (prop === "Timestamp") return Object(0n); // reset echoes the fresh clock
      return true;
    });
  }
  const Protocol = {
    System: {
      Enable: "Enable",
      Info: "Info",
      Version: "Version",
      Timestamp: "Timestamp",
    },
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
import { workloadSnapshot } from "@orchestrator/metering";

const PORT = "/dev/fake-controller";
const NAME = `controller:${PORT}`;
const packets = () => workloadSnapshot(NAME)!.outputs.packets.count;

describe("Controller serial WRITE meter", () => {
  let ctrl: Controller | undefined;
  afterEach(() => {
    ctrl?.release(); // idempotent; disposes the meter between tests
    ctrl = undefined;
  });

  it("registers a controller:<port> workload with a zeroed packets output", () => {
    ctrl = new Controller({ path: PORT } as never);
    // Checked synchronously — the async `ready` config sequence has not run yet.
    const snap = workloadSnapshot(NAME);
    expect(snap).toBeTruthy();
    expect(snap!.outputs.packets).toEqual({
      count: 0,
      ratePerSec: 0,
      maxIntervalMs: 0,
    });
  });

  it("emits one packet per awaited send (config sequence + actuate + enable)", async () => {
    ctrl = new Controller({ path: PORT } as never);
    await ctrl.ready; // verifyVersion + disable + setBias + setLPF + setLogLevel
    const afterInit = packets();
    expect(afterInit).toBeGreaterThan(0); // the init config writes were counted

    await ctrl.actuate({ left: { x: 1, y: 1 }, right: { x: 2, y: 2 } });
    await ctrl.enable();
    expect(packets()).toBe(afterInit + 2); // one actuate packet + one enable packet
  });

  it("counts the fire-and-forget stream update hot path", async () => {
    ctrl = new Controller({ path: PORT } as never);
    await ctrl.ready;
    const stream = await ctrl.createStream({
      left: { x: 0, y: 0 },
      right: { x: 0, y: 0 },
    });
    const before = packets(); // includes the CREATE packet
    // Real 2 ms delay clears the 1 ms per-stream min-interval gate so the
    // update actually sends (gate suppression is covered separately).
    await new Promise((r) => setTimeout(r, 2));
    stream.update({ left: { x: 3, y: 3 }, right: { x: 4, y: 4 } });
    expect(packets()).toBe(before + 1);
  });

  it("meters and decodes the System.Timestamp calibration ping + reset", async () => {
    ctrl = new Controller({ path: PORT } as never);
    await ctrl.ready;
    const before = packets();
    // readTimestamp resolves the MCU clock as a PRIMITIVE µs bigint.
    await expect(ctrl.readTimestamp()).resolves.toBe(123_456_789n);
    await ctrl.resetTimestamp();
    // One GET packet (the ping) + one SET packet (the reset).
    expect(packets()).toBe(before + 2);
  });

  it("disposes the meter on release (the row disappears)", () => {
    ctrl = new Controller({ path: PORT } as never);
    expect(workloadSnapshot(NAME)).toBeTruthy();
    ctrl.release();
    expect(workloadSnapshot(NAME)).toBeUndefined();
    ctrl = undefined; // already released
  });
});
