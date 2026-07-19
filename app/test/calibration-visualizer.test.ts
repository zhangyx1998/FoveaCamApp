// Coverage for the extrinsic-visualizer projection math
// (`@lib/calibration-visualizer`): against a synthetic identity-ish calibration
// (a marker observed as an exact scaled + translated copy of its object corners
// at zero angle) the projected corners land ON the observed corners — zero
// residual — and the fitted scale recovers the applied factor. Also covers the
// viewBox (true sensor aspect when known, else a padded data box).

import { describe, expect, it } from "vitest";
import type { ExtrinsicData } from "@lib/camera-config";
import {
  fitScale,
  projectDataset,
  viewBoxFor,
} from "@lib/calibration-visualizer";

const UNIT_CORNERS = [
  { x: -0.5, y: -0.5, z: 0 },
  { x: 0.5, y: -0.5, z: 0 },
  { x: 0.5, y: 0.5, z: 0 },
  { x: -0.5, y: 0.5, z: 0 },
];

/** A datapoint whose observed image corners are the object corners scaled by
 *  `scale` and translated by (tx, ty), captured at zero angle. The pinhole
 *  model must reproject exactly onto these. */
function identityDatapoint(scale: number, tx: number, ty: number): ExtrinsicData {
  return {
    img_points: UNIT_CORNERS.map((p) => ({ x: p.x * scale + tx, y: p.y * scale + ty })),
    obj_points: UNIT_CORNERS.map((p) => ({ ...p })),
    voltage: { x: 0, y: 0 },
    angle: { x: 0, y: 0 },
  };
}

describe("projectDataset — synthetic identity calibration", () => {
  it("projects exactly onto the observed corners (zero residual)", () => {
    const dataset = [
      identityDatapoint(400, 700, 500),
      identityDatapoint(400, 300, 900),
    ];
    const proj = projectDataset(dataset);
    // Scale recovered.
    expect(proj.scale).toBeCloseTo(400, 6);
    // Every corner reprojects onto its observation.
    for (const pt of proj.points) {
      for (let i = 0; i < pt.observed.length; i++) {
        expect(pt.projected[i]!.x).toBeCloseTo(pt.observed[i]!.x, 6);
        expect(pt.projected[i]!.y).toBeCloseTo(pt.observed[i]!.y, 6);
        expect(pt.residuals[i]).toBeCloseTo(0, 6);
      }
    }
    expect(proj.rms).toBeCloseTo(0, 6);
  });

  it("reports a nonzero residual when an observation is perturbed", () => {
    const d = identityDatapoint(400, 700, 500);
    d.img_points[0] = { x: d.img_points[0]!.x + 25, y: d.img_points[0]!.y - 10 };
    const proj = projectDataset([d]);
    expect(proj.rms).toBeGreaterThan(0);
    // The perturbation redistributes through the refit center/scale, so the
    // peak corner residual is a fraction of the raw nudge — but clearly nonzero.
    expect(Math.max(...proj.points[0]!.residuals)).toBeGreaterThan(10);
  });

  it("fitScale falls back to 1 on an all-degenerate dataset", () => {
    const degenerate: ExtrinsicData = {
      img_points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
      obj_points: UNIT_CORNERS.map((p) => ({ ...p })),
      voltage: { x: 0, y: 0 },
      angle: { x: 0, y: 0 },
    };
    expect(fitScale([degenerate])).toBe(1);
  });
});

describe("viewBoxFor", () => {
  it("uses the true sensor size when known (origin at 0,0)", () => {
    const proj = projectDataset([identityDatapoint(400, 700, 500)]);
    expect(viewBoxFor(proj, { width: 1440, height: 1080 })).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 1080,
    });
  });

  it("fits a padded bounding box when the sensor size is unknown", () => {
    const proj = projectDataset([identityDatapoint(400, 700, 500)]);
    const vb = viewBoxFor(proj, null);
    // The box contains every point with a margin.
    expect(vb.x).toBeLessThan(proj.bounds.minX);
    expect(vb.y).toBeLessThan(proj.bounds.minY);
    expect(vb.width).toBeGreaterThan(proj.bounds.maxX - proj.bounds.minX);
    expect(vb.height).toBeGreaterThan(proj.bounds.maxY - proj.bounds.minY);
  });
});
