// `createDataSet` (calibrate-extrinsic/dataset.ts) reshapes captured
// `ExtrinsicRecord`s into the per-fovea `ExtrinsicDataset` the regression fit
// consumes. It also threads the wide-camera marker quads + marker sizes per eye
// — optional, so a
// legacy record (missing those fields) must still reshape cleanly. Pure (types
// only), no orchestrator runtime needed.

import { describe, expect, it } from "vitest";

import {
  computeFinStats,
  createDataSet,
  MIN_FIT_SAMPLES,
  type A2VPredict,
} from "@modules/calibrate-extrinsic/dataset";
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
    // The wide camera's view of THIS eye's side marker.
    expect(dsL!.wide_img_points).toEqual(quad(11));
    // Fallback: C's own center-marker outer quad (first 4).
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

  // Pin the per-eye field THREADING no earlier test asserted — a
  // swapped eye (R dataset carrying L's voltage/obj_points) would fit a
  // plausible-looking but crossed regression.
  it("threads obj_points per eye (L3)", () => {
    const rec = fullRecord();
    const objR: Point3d[] = obj.map((p) => ({ ...p, z: 9 })); // distinguishable
    rec.R.obj_pts = objR;
    const [dsL] = createDataSet([rec], "L");
    const [dsR] = createDataSet([rec], "R");
    expect(dsL!.obj_points).toEqual(obj);
    expect(dsR!.obj_points).toEqual(objR); // R's own obj points — never L's
  });

  it("maps the R record's voltage into the R dataset (L3 — never the L voltage)", () => {
    const [dsR] = createDataSet([fullRecord()], "R");
    expect(dsR!.voltage).toEqual({ x: 3, y: 4 }); // R.voltage
    expect(dsR!.img_points).toEqual(quad(80)); // R's own quad
    // Both eyes share the CENTER angle (the regression input) by design.
    expect(dsR!.angle).toEqual({ x: 0.1, y: 0.2 });
  });
});

describe("computeFinStats (residual surfacing)", () => {
  // A linear predictor whose error vs the recorded voltage is exactly known.
  const exact: A2VPredict = { predict: () => ({ x: 1, y: 2 }) }; // == L.voltage
  const off: A2VPredict = { predict: () => ({ x: 3, y: 8 }) }; // R.voltage + (0,4)

  it("computes per-record volt-space residuals + per-eye RMS", () => {
    const fin = computeFinStats([fullRecord(), fullRecord()], { L: exact, R: off });
    expect(fin.samples).toBe(2);
    expect(fin.minSamples).toBe(MIN_FIT_SAMPLES);
    expect(fin.residuals).toHaveLength(2);
    expect(fin.residuals[0]!.L).toBeCloseTo(0, 12); // exact fit
    expect(fin.residuals[0]!.R).toBeCloseTo(4, 12); // |(3,8)-(3,4)| = 4
    expect(fin.rmsL).toBeCloseTo(0, 12);
    expect(fin.rmsR).toBeCloseTo(4, 12);
  });

  it("a missing fit (gated / failed) yields null residuals + null RMS", () => {
    const fin = computeFinStats([fullRecord()], { L: null, R: null });
    expect(fin.residuals[0]).toEqual({ L: null, R: null });
    expect(fin.rmsL).toBeNull();
    expect(fin.rmsR).toBeNull();
  });

  it("a non-finite prediction degrades that record to null (never NaN telemetry)", () => {
    const bad: A2VPredict = { predict: () => ({ x: NaN, y: 0 }) };
    const fin = computeFinStats([fullRecord()], { L: bad, R: exact });
    expect(fin.residuals[0]!.L).toBeNull();
    expect(fin.rmsL).toBeNull();
  });

  it("MIN_FIT_SAMPLES matches the fit gate", () => {
    expect(MIN_FIT_SAMPLES).toBe(10);
  });
});
