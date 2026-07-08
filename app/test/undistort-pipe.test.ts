// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `undistort-pipe` (C-23, real-1g): the session-scoped `camera/<serial>/undistort`
// advertise/retire helper, unit-tested over an injected fake seam (never loads
// native core / the pipe session). Encoding is RULED: id `camera/<serial>/undistort`,
// format in `spec.pixelFormat` (BGRA8), same dims as the camera.

import { describe, expect, it, vi } from "vitest";
import {
  advertiseUndistortPipe,
  retireUndistortPipe,
  undistortPipeId,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";

const CAL = { sensor_size: { width: 4, height: 3 } } as never;

function fakeSeam() {
  const calls: string[] = [];
  const seam: UndistortPipeSeam = {
    advertise: vi.fn((_spec) => (calls.push("advertise"), 1)),
    unadvertise: vi.fn(() => calls.push("unadvertise")),
    attach: vi.fn(() => calls.push("attach")),
    detach: vi.fn(() => calls.push("detach")),
  };
  return { seam, calls };
}

const fakeCamera = () =>
  ({
    serial: "SN42",
    getFeatureInt: (name: string) => (name === "Width" ? 640 : 480),
  }) as never;

describe("undistort-pipe (C-23)", () => {
  it("advertises the ruled id + BGRA8 spec at camera dims, then attaches", () => {
    const { seam, calls } = fakeSeam();
    const id = advertiseUndistortPipe(seam, fakeCamera(), CAL);
    expect(id).toBe("camera/SN42/undistort");
    expect(undistortPipeId("SN42")).toBe(id);
    expect(seam.advertise).toHaveBeenCalledWith({
      id: "camera/SN42/undistort",
      pixelFormat: "BGRA8",
      dtype: "U8",
      width: 640,
      height: 480,
      channels: 4,
      stride: 640 * 4,
      bytesPerFrame: 640 * 480 * 4,
      ringDepth: 4,
    });
    // Advertise BEFORE attach: the producer must find its pipe.
    expect(calls).toEqual(["advertise", "attach"]);
    const attach = seam.attach as ReturnType<typeof vi.fn>;
    expect(attach.mock.calls[0]![1]).toBe("camera/SN42/undistort");
    expect(attach.mock.calls[0]![2]).toBe(CAL); // plain cal record, untouched
  });

  it("retire detaches the producer BEFORE un-advertising", () => {
    const { seam, calls } = fakeSeam();
    retireUndistortPipe(seam, "camera/SN42/undistort");
    expect(calls).toEqual(["detach", "unadvertise"]);
    expect(seam.detach).toHaveBeenCalledWith("camera/SN42/undistort");
    expect(seam.unadvertise).toHaveBeenCalledWith("camera/SN42/undistort");
  });
});
