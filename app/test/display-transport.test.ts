// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `display-transport` calibration (de)serialization (C-22b step 2). The display
// kernel reconstructs `new Undistort(cal)` in the worker, but `CameraCalibration`
// carries `Mat<Float64Array>` fields — a TypedArray with tacked-on `shape`/
// `channels` that structuredClone DROPS. These flatten-then-rebuild helpers must
// survive a JSON round-trip (the worst case a MessagePort clone can impose) with
// shape/channels intact — that preservation is the whole reason they exist.

import { describe, it, expect } from "vitest";
import { makeMat } from "@lib/mat";
import {
  serializeCalibration,
  deserializeCalibration,
} from "@orchestrator/display-transport";
import type { CameraCalibration } from "core/Vision";

function fakeCalibration(): CameraCalibration {
  return {
    date: new Date("2026-07-08T00:00:00Z"),
    sensor_size: { width: 1920, height: 1080 },
    camera_matrix: makeMat(new Float64Array([1000, 0, 960, 0, 1000, 540, 0, 0, 1]), [3, 3], 1),
    dist_coeffs: makeMat(new Float64Array([-0.1, 0.05, 0.001, -0.002, 0]), [1, 5], 1),
    rvecs: [makeMat(new Float64Array([0.01, -0.02, 0.03]), [3, 1], 1)],
    tvecs: [makeMat(new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), [3, 4], 1)],
  };
}

describe("display-transport calibration serialization", () => {
  it("survives a JSON round-trip with shape/channels preserved", () => {
    const cal = fakeCalibration();
    // JSON round-trip = the harshest clone (structuredClone would keep the
    // Float64Array buffer but still drop shape/channels — same failure).
    const wire = JSON.parse(JSON.stringify(serializeCalibration(cal)));
    const back = deserializeCalibration(wire);

    expect(back.sensor_size).toEqual({ width: 1920, height: 1080 });
    expect(back.date.getTime()).toBe(cal.date.getTime());

    const eq = (a: { shape: number[]; channels: number }, b: typeof a) => {
      expect([...a.shape]).toEqual([...b.shape]);
      expect(a.channels).toBe(b.channels);
      expect(Array.from(a as unknown as Float64Array)).toEqual(
        Array.from(b as unknown as Float64Array),
      );
    };
    eq(back.camera_matrix, cal.camera_matrix);
    eq(back.dist_coeffs, cal.dist_coeffs);
    expect(back.rvecs).toHaveLength(1);
    expect(back.tvecs).toHaveLength(1);
    eq(back.rvecs[0]!, cal.rvecs[0]!);
    eq(back.tvecs[0]!, cal.tvecs[0]!);
  });

  it("rebuilt Mats are real Float64Array typed arrays (not plain arrays)", () => {
    const back = deserializeCalibration(
      JSON.parse(JSON.stringify(serializeCalibration(fakeCalibration()))),
    );
    expect(back.camera_matrix).toBeInstanceOf(Float64Array);
    expect(back.dist_coeffs.shape).toEqual([1, 5]);
  });
});
