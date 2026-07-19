// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Session-seam test for the split-tracking px→volt Jacobian helper (jacobian.ts)
// — the PURE geometric core the session finite-differences per tick. No native
// addon: the calibration objects (focal + A2V) are supplied as plain functions.

import { describe, it, expect } from "vitest";
import type { Point2d } from "core/Geometry";
import { eyeJInv } from "@modules/split-tracking/jacobian";

describe("eyeJInv", () => {
  // A2V that is LINEAR in angle so the finite difference is exact:
  //   volt = M · angle,  M = [[gx, 0],[0, gy]]  (volts per radian).
  const gx = 40;
  const gy = 25;
  const a2v = (a: Point2d): Point2d => ({ x: gx * a.x, y: gy * a.y });
  const focal = { x: 800, y: 600 }; // px per radian

  it("is d(volt)/d(px) = (volt-per-rad) / focal on the diagonal", () => {
    const [a, b, c, d] = eyeJInv({ focal, angle0: { x: 0.1, y: -0.2 }, a2v });
    // dVx/dpx_x = gx * (1/focal.x); off-diagonals ~0 for a diagonal A2V + focal.
    expect(a).toBeCloseTo(gx / focal.x, 9);
    expect(b).toBeCloseTo(0, 9);
    expect(c).toBeCloseTo(0, 9);
    expect(d).toBeCloseTo(gy / focal.y, 9);
  });

  it("does not depend on angle0 for a linear A2V (constant Jacobian)", () => {
    const j0 = eyeJInv({ focal, angle0: { x: 0, y: 0 }, a2v });
    const j1 = eyeJInv({ focal, angle0: { x: 0.3, y: 0.4 }, a2v });
    for (let i = 0; i < 4; i++) expect(j0[i]).toBeCloseTo(j1[i], 9);
  });

  it("flips sign with the RIG-tunable per-axis sign", () => {
    const pos = eyeJInv({ focal, angle0: { x: 0, y: 0 }, a2v, signX: 1 });
    const neg = eyeJInv({ focal, angle0: { x: 0, y: 0 }, a2v, signX: -1 });
    expect(neg[0]).toBeCloseTo(-pos[0], 9);
  });

  it("scales inversely with focal (a wider focal ⇒ finer volt-per-px)", () => {
    const tight = eyeJInv({ focal: { x: 400, y: 300 }, angle0: { x: 0, y: 0 }, a2v });
    const wide = eyeJInv({ focal: { x: 800, y: 600 }, angle0: { x: 0, y: 0 }, a2v });
    expect(Math.abs(wide[0])).toBeCloseTo(Math.abs(tight[0]) / 2, 9);
  });

  it("returns a zero matrix for a degenerate (zero / non-finite) focal", () => {
    expect(eyeJInv({ focal: { x: 0, y: 600 }, angle0: { x: 0, y: 0 }, a2v })).toEqual([0, 0, 0, 0]);
    expect(
      eyeJInv({ focal: { x: NaN, y: 600 }, angle0: { x: 0, y: 0 }, a2v }),
    ).toEqual([0, 0, 0, 0]);
  });
});
