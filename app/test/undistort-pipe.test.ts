// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `undistort-pipe` (C-23, real-1g; §5 re-chain): the session-scoped
// `camera/<serial>/undistort` advertise/retire helper, unit-tested over an
// injected fake seam (never loads native core / the pipe session). Encoding is
// RULED: id `camera/<serial>/undistort`, format in `spec.pixelFormat` (RGBA8),
// same dims as the camera. Since unified-time-and-topology §5 the brick CHAINS
// ON THE SHARED CONVERTER — attach's source is `camera/<serial>/convert`, not
// the Camera object — in one of two variants: intrinsic `{cal}` (center) or
// `{homography: true}` (mirror-steered L/R).

import { describe, expect, it, vi } from "vitest";
import {
  advertiseHomographyUndistortPipe,
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

describe("undistort-pipe (C-23, §5 re-chain)", () => {
  it("advertises the ruled id + RGBA8 spec at camera dims, then attaches CHAINED on the convert pipe", () => {
    const { seam, calls } = fakeSeam();
    const id = advertiseUndistortPipe(seam, fakeCamera(), CAL);
    expect(id).toBe("camera/SN42/undistort");
    expect(undistortPipeId("SN42")).toBe(id);
    expect(seam.advertise).toHaveBeenCalledWith({
      id: "camera/SN42/undistort",
      pixelFormat: "RGBA8",
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
    // §5: source = the SHARED converter's pipe id (legacy Camera arg retired);
    // intrinsic variant carries the plain cal record, untouched.
    expect(seam.attach).toHaveBeenCalledWith(
      "camera/SN42/convert",
      "camera/SN42/undistort",
      { cal: CAL },
    );
  });

  it("homography variant: same pipe spec, `{homography: true}` attach on the convert pipe", () => {
    const { seam, calls } = fakeSeam();
    const id = advertiseHomographyUndistortPipe(seam, fakeCamera());
    expect(id).toBe("camera/SN42/undistort");
    expect(calls).toEqual(["advertise", "attach"]);
    const advertise = seam.advertise as ReturnType<typeof vi.fn>;
    expect(advertise.mock.calls[0]![0]).toMatchObject({
      id: "camera/SN42/undistort",
      pixelFormat: "RGBA8",
      width: 640,
      height: 480,
    });
    expect(seam.attach).toHaveBeenCalledWith(
      "camera/SN42/convert",
      "camera/SN42/undistort",
      { homography: true },
    );
  });

  it("homography variant forwards an explicit ringCapacity", () => {
    const { seam } = fakeSeam();
    advertiseHomographyUndistortPipe(seam, fakeCamera(), 64);
    expect(seam.attach).toHaveBeenCalledWith(
      "camera/SN42/convert",
      "camera/SN42/undistort",
      { homography: true, ringCapacity: 64 },
    );
  });

  it("retire detaches the producer BEFORE un-advertising", () => {
    const { seam, calls } = fakeSeam();
    retireUndistortPipe(seam, "camera/SN42/undistort");
    expect(calls).toEqual(["detach", "unadvertise"]);
    expect(seam.detach).toHaveBeenCalledWith("camera/SN42/undistort");
    expect(seam.unadvertise).toHaveBeenCalledWith("camera/SN42/undistort");
  });
});
