// Controller MEMS recovery (right-dac-freeze M2,
// docs/dev/right-dac-freeze-2026-07-12.md). `recoverMems()` re-inits the MEMS
// DACs in place via System::Reset(MEMS = 2) WITHOUT dropping the session.
// Verifies: (1) it sends the MEMS reset enum on capable firmware; (2) it is
// version-gated — a hard reject below 2.1.0 with nothing put on the wire;
// (3) a firmware REJ propagates to the caller. A fake `Device` keeps serial
// hardware out of the loop, matching the other controller-*.test.ts seams.

import { afterEach, describe, expect, it, vi } from "vitest";

// The version the fake `verifyVersion` reports — mutated per test BEFORE
// constructing the Controller so `ready` captures it. Declared with a `mock`
// prefix so the hoisted `vi.mock` factory may close over it (vitest allowlist).
const mockFirmware = { major: 2, minor: 1, patch: 0 };
// Records every device.set(prop, arg) so a test can assert the exact enum.
const mockSetCalls: Array<{ prop: string; arg: unknown }> = [];
// When set, the fake device.set REJects System::Reset with this error.
let mockResetReject: Error | null = null;

vi.mock("core/Controller", () => {
  class FakeDevice {
    connected = true;
    v2Capable = true;
    stats = {};
    constructor(_path: string) {
      void _path;
    }
    verifyVersion = vi.fn(async () => ({ ...mockFirmware, compatible: true }));
    release = vi.fn();
    fireAndForget = vi.fn();
    get = vi.fn(async () => undefined);
    set = vi.fn(async (prop: string, arg: unknown) => {
      mockSetCalls.push({ prop, arg });
      if (prop === "Reset" && mockResetReject) throw mockResetReject;
      if (prop === "Bias") return 200;
      return true;
    });
  }
  const Protocol = {
    System: {
      Enable: "Enable",
      Info: "Info",
      Version: "Version",
      Reset: "Reset",
      Timestamp: "Timestamp",
    },
    Config: { Log: "Log", LPF: "LPF", Bias: "Bias" },
    Command: { Actuate: "Actuate", Trigger: "Trigger" },
  };
  return { Device: FakeDevice, Protocol };
});
vi.mock("serialport", () => ({ SerialPort: { list: vi.fn(async () => []) } }));

import { Controller } from "@orchestrator/controller";

const PORT = "/dev/fake-controller";

async function makeController(firmware: {
  major: number;
  minor: number;
  patch: number;
}): Promise<Controller> {
  Object.assign(mockFirmware, firmware);
  const ctrl = new Controller({ path: PORT } as never);
  await ctrl.ready;
  return ctrl;
}

describe("Controller.recoverMems (right-dac-freeze M2)", () => {
  let ctrl: Controller | undefined;
  afterEach(() => {
    ctrl?.release();
    ctrl = undefined;
    mockSetCalls.length = 0;
    mockResetReject = null;
  });

  it("sends System::Reset with the MEMS enum on firmware >= 2.1.0", async () => {
    ctrl = await makeController({ major: 2, minor: 1, patch: 0 });
    expect(ctrl.v21Capable).toBe(true);
    mockSetCalls.length = 0; // ignore the init config writes

    await ctrl.recoverMems();

    const reset = mockSetCalls.filter((c) => c.prop === "Reset");
    expect(reset).toHaveLength(1);
    // "MEMS" is the EnumPacket name the firmware maps to Reset::Type::MEMS
    // (wire value 2) — the pinned contract.
    expect(reset[0].arg).toBe("MEMS");
  });

  it("is gated below 2.1.0 — rejects and sends nothing", async () => {
    ctrl = await makeController({ major: 2, minor: 0, patch: 0 });
    expect(ctrl.v21Capable).toBe(false);
    mockSetCalls.length = 0;

    await expect(ctrl.recoverMems()).rejects.toThrow(/2\.1\.0/);
    expect(mockSetCalls.some((c) => c.prop === "Reset")).toBe(false);
  });

  it("gates a newer minor/major up (2.2.0, 3.0.0) but not 2.0.9", async () => {
    ctrl = await makeController({ major: 2, minor: 2, patch: 0 });
    expect(ctrl.v21Capable).toBe(true);
    ctrl.release();

    ctrl = await makeController({ major: 3, minor: 0, patch: 0 });
    expect(ctrl.v21Capable).toBe(true);
    ctrl.release();

    ctrl = await makeController({ major: 2, minor: 0, patch: 9 });
    expect(ctrl.v21Capable).toBe(false);
  });

  it("propagates a firmware REJ to the caller", async () => {
    ctrl = await makeController({ major: 2, minor: 1, patch: 0 });
    mockResetReject = new Error("REJ: system disabled");

    await expect(ctrl.recoverMems()).rejects.toThrow("REJ: system disabled");
  });
});
