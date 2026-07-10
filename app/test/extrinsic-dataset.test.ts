// `createDataSet` (calibrate-extrinsic/dataset.ts) reshapes captured
// `ExtrinsicRecord`s into the per-fovea `ExtrinsicDataset` the regression fit
// consumes. Since the measured-magnification fix (ruled 2026-07-09) it also
// threads the wide-camera marker quads + marker sizes per eye — optional, so a
// legacy record (missing those fields) must still reshape cleanly. Pure (types
// only), no orchestrator runtime needed.

import { describe, expect, it } from "vitest";

import { createDataSet } from "@modules/calibrate-extrinsic/dataset";
import type { ExtrinsicRecord } from "@modules/calibrate-extrinsic/contract";
import type { Point2d, Point3d } from "core/Geometry";

const quad = (s: number): Point2d[] => [
  { x: 0, y: 0 },
  { x: s, y: 0 },
  { x: s, y: s },
  { x: 0, y: s },
];
const obj: Point3d[] = [
  { x: -0.5, y: -0.5, z: 0 },
  { x: 0.5, y: -0.5, z: 0 },
  { x: 0.5, y: 0.5, z: 0 },
  { x: -0.5, y: 0.5, z: 0 },
];

function fullRecord(): ExtrinsicRecord {
  return {
    L: { img_pts: quad(90), obj_pts: obj, voltage: { x: 1, y: 2 } },
    C: {
      img_pts: quad(10),
      obj_pts: obj,
      angle: { x: 0.1, y: 0.2 },
      side_pts: { L: quad(11), R: quad(12) },
      marker: { side_mm: 20, center_mm: 10 },
    },
    R: { img_pts: quad(80), obj_pts: obj, voltage: { x: 3, y: 4 } },
  };
}

describe("createDataSet (measured-magnification field threading)", () => {
  it("carries the wide side-marker quad + center quad + marker sizes per eye", () => {
    const [dsL] = createDataSet([fullRecord()], "L");
    expect(dsL!.img_points).toEqual(quad(90)); // this eye's fovea quad
    expect(dsL!.voltage).toEqual({ x: 1, y: 2 });
    expect(dsL!.angle).toEqual({ x: 0.1, y: 0.2 }); // from C
    // Ruling 3: the wide camera's view of THIS eye's side marker.
    expect(dsL!.wide_img_points).toEqual(quad(11));
    // Ruling 2 fallback: C's own center-marker outer quad (first 4).
    expect(dsL!.wide_center_points).toEqual(quad(10));
    expect(dsL!.marker).toEqual({ side_mm: 20, center_mm: 10 });

    const [dsR] = createDataSet([fullRecord()], "R");
    expect(dsR!.img_points).toEqual(quad(80));
    expect(dsR!.wide_img_points).toEqual(quad(12)); // R side marker
  });

  it("takes only the first 4 of C.img_pts for the center quad (drops internal corners)", () => {
    const r = fullRecord();
    r.C.img_pts = [...quad(10), { x: 5, y: 5 }, { x: 6, y: 6 }]; // + internal
    const [ds] = createDataSet([r], "L");
    expect(ds!.wide_center_points).toHaveLength(4);
    expect(ds!.wide_center_points).toEqual(quad(10));
  });

  it("tolerates a legacy record with no measured-magnification fields", () => {
    const legacy: ExtrinsicRecord = {
      L: { img_pts: quad(90), obj_pts: obj, voltage: { x: 1, y: 2 } },
      C: { img_pts: quad(10), obj_pts: obj, angle: { x: 0.1, y: 0.2 } },
      R: { img_pts: quad(80), obj_pts: obj, voltage: { x: 3, y: 4 } },
    };
    const [ds] = createDataSet([legacy], "L");
    expect(ds!.wide_img_points).toBeUndefined(); // no side_pts on the record
    expect(ds!.marker).toBeUndefined();
    // The center quad is always derivable (C.img_pts always present); the fit
    // still degrades to "no measured magnification" without side_pts + marker.
    expect(ds!.wide_center_points).toEqual(quad(10));
  });

  it("threads a per-eye-absent side quad (wide camera saw one side but not the other)", () => {
    const r = fullRecord();
    r.C.side_pts = { L: quad(11) }; // R side marker not seen this capture
    expect(createDataSet([r], "L")[0]!.wide_img_points).toEqual(quad(11));
    expect(createDataSet([r], "R")[0]!.wide_img_points).toBeUndefined();
  });
});
