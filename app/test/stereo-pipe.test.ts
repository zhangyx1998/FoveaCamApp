// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Stereo pipe seam plumbing + the RULED signed window (sgbm-signed-range.md +
// stereo-throughput.md): the window constant BOTH sessions attach with, the
// params pass-through on attach/attachPaired/retune (including the new
// throughput strategy params), and the advert/retire lifecycle.

import { describe, expect, it } from "vitest";
import {
  createPairedStereoPipe,
  createStereoPipe,
  SIGNED_DISPARITY_WINDOW,
  type StereoParams,
  type StereoPipeSeam,
} from "../orchestrator/stereo-pipe";
import type { PipeSpec } from "@lib/orchestrator/pipe-contract";

function fakeSeam() {
  const calls: {
    adverts: PipeSpec[];
    attaches: Array<{ left: string; right: string; pipeId: string; params: StereoParams }>;
    paired: Array<{ stage: string; pipeId: string; params: StereoParams }>;
    retunes: Array<{ pipeId: string; params: StereoParams }>;
    detached: string[];
    unadvertised: string[];
  } = { adverts: [], attaches: [], paired: [], retunes: [], detached: [], unadvertised: [] };
  const seam: StereoPipeSeam = {
    advertise: (spec) => (calls.adverts.push(spec), 1),
    unadvertise: (pipeId) => void calls.unadvertised.push(pipeId),
    attach: (left, right, pipeId, params) =>
      void calls.attaches.push({ left, right, pipeId, params }),
    attachPaired: (stage, pipeId, params) =>
      void calls.paired.push({ stage, pipeId, params }),
    retune: (pipeId, params) => void calls.retunes.push({ pipeId, params }),
    detach: (pipeId) => void calls.detached.push(pipeId),
  };
  return { seam, calls };
}

describe("SIGNED_DISPARITY_WINDOW (sgbm-signed-range.md ruling)", () => {
  it("is the fixed symmetric −256…+255 window", () => {
    expect(SIGNED_DISPARITY_WINDOW).toEqual({
      numDisparities: 512,
      minDisparity: -256,
    });
  });
});

describe("createStereoPipe", () => {
  it("advertises the F32 pipe and attaches with the passed params", () => {
    const { seam, calls } = fakeSeam();
    const h = createStereoPipe(seam, "camera/1/undistort", "camera/2/undistort", "stereo/scope", {
      maxWidth: 1440,
      maxHeight: 1080,
      params: SIGNED_DISPARITY_WINDOW,
    });
    expect(calls.adverts).toHaveLength(1);
    expect(calls.adverts[0]).toMatchObject({
      id: "stereo/scope",
      pixelFormat: "Disparity32F",
      dtype: "F32",
      maxWidth: 1440,
      maxHeight: 1080,
    });
    expect(calls.attaches).toEqual([
      {
        left: "camera/1/undistort",
        right: "camera/2/undistort",
        pipeId: "stereo/scope",
        params: { numDisparities: 512, minDisparity: -256 },
      },
    ]);
    // Live retune carries the FULL throughput param surface (stereo-throughput).
    h.retune({
      ...SIGNED_DISPARITY_WINDOW,
      algorithm: "bm",
      mode: "3way",
      matchScale: 2,
      wls: true,
      wlsLambda: 4000,
      wlsSigma: 1.0,
    });
    expect(calls.retunes[0]!.params).toMatchObject({
      numDisparities: 512,
      minDisparity: -256,
      algorithm: "bm",
      matchScale: 2,
      wls: true,
    });
    h.retire();
    expect(calls.detached).toEqual(["stereo/scope"]);
    expect(calls.unadvertised).toEqual(["stereo/scope"]);
  });
});

describe("createPairedStereoPipe", () => {
  it("attaches the paired variant with the same params + advert", () => {
    const { seam, calls } = fakeSeam();
    createPairedStereoPipe(seam, "pair/undistort", "stereo/paired", {
      maxWidth: 1440,
      maxHeight: 1080,
      params: SIGNED_DISPARITY_WINDOW,
    });
    expect(calls.adverts[0]).toMatchObject({ id: "stereo/paired", pixelFormat: "Disparity32F" });
    expect(calls.paired).toEqual([
      {
        stage: "pair/undistort",
        pipeId: "stereo/paired",
        params: { numDisparities: 512, minDisparity: -256 },
      },
    ]);
  });
});
