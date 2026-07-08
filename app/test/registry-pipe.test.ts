// WS1 real-1c: the registry's camera-pipe seam — on shared-camera acquire it
// advertises a `camera:<serial>` BGRA8 pipe + attaches B's native producer; on
// last release it detaches + un-advertises. The full `acquire()` path is native
// (camera enumeration) and not unit-testable, so the pure seam helpers carry the
// spec construction + advertise/attach/detach that this test pins.

import { describe, expect, it, vi } from "vitest";
import {
  advertiseCameraPipe,
  retireCameraPipe,
  type RegistryPipeSeam,
} from "@orchestrator/registry";
import type { Camera } from "core/Aravis";

function fakeSeam(): RegistryPipeSeam & {
  advertise: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  unadvertise: ReturnType<typeof vi.fn>;
} {
  return {
    advertise: vi.fn(() => 1),
    unadvertise: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
  };
}

const fakeCamera = (serial: string, w: number, h: number) =>
  ({
    serial,
    getFeatureInt: (k: string) => (k === "Width" ? w : k === "Height" ? h : 0),
  }) as unknown as Pick<Camera, "serial" | "getFeatureInt">;

describe("registry camera-pipe seam (real-1c)", () => {
  it("advertises a BGRA8 camera:<serial> pipe with the camera's geometry + attaches", () => {
    const seam = fakeSeam();
    const pipeId = advertiseCameraPipe(seam, fakeCamera("SN1", 640, 480));
    expect(pipeId).toBe("camera/SN1/convert");
    expect(seam.advertise).toHaveBeenCalledTimes(1);
    expect(seam.advertise).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "camera/SN1/convert",
        pixelFormat: "BGRA8",
        dtype: "U8",
        width: 640,
        height: 480,
        channels: 4,
        stride: 640 * 4,
        bytesPerFrame: 640 * 480 * 4,
        ringDepth: 4,
      }),
    );
    // attach happens AFTER advertise (B reads the advertised geometry).
    expect(seam.attach).toHaveBeenCalledWith(expect.anything(), "camera/SN1/convert");
    expect(seam.advertise.mock.invocationCallOrder[0]).toBeLessThan(
      seam.attach.mock.invocationCallOrder[0],
    );
  });

  it("retires the pipe as detach → unadvertise", () => {
    const seam = fakeSeam();
    retireCameraPipe(seam, "camera/SN1/convert");
    expect(seam.detach).toHaveBeenCalledWith("camera/SN1/convert");
    expect(seam.unadvertise).toHaveBeenCalledWith("camera/SN1/convert");
    expect(seam.detach.mock.invocationCallOrder[0]).toBeLessThan(
      seam.unadvertise.mock.invocationCallOrder[0],
    );
  });
});
