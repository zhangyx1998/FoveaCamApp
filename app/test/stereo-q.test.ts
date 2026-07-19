// Depth-path math — the pure stereo
// lib (@lib/stereo): createQMatrix's principal-point disparity offset sign
// places the fixation plane at POSITIVE depth, and vergenceToDistance's
// exact symmetric-fixation inverse. Fixtures reproduce
// deriveFoveaIntrinsics' ideal-pinhole output
// for a CONVERGED pose, and reprojection applies Q exactly the way
// cv::reprojectImageTo3D does ([X Y Z W]ᵀ = Q·[u v d 1]ᵀ, point = ·/W).

import { describe, expect, it } from "vitest";
import {
  createQMatrix,
  inverseTriangulate,
  vergenceToDistance,
  distanceToVerge,
  vergeToDistance,
  type FoveaIntrinsics,
} from "@lib/stereo";

// --- fixture: ideal pinhole, converged at zFix on the gaze axis ---------------
// deriveFoveaIntrinsics for a fovea pointing along angle a (zoom 1):
// vc = tan(a)·f + c0.x, delta = vc − c0.x, c.x = W/2 − delta. With the
// symmetric toe-in of inverseTriangulate (aL = atan(+b/z), aR = atan(−b/z),
// b = B/2): cL.x = W/2 − f·b/z, cR.x = W/2 + f·b/z.
const F = 1000; // px
const W = 1920,
  H = 1200;
const B = 30; // mm
const Z_FIX = 800; // mm

function convergedIntrinsics(zFix: number): { L: FoveaIntrinsics; R: FoveaIntrinsics } {
  const shift = (F * (B / 2)) / zFix;
  const mk = (cxShift: number): FoveaIntrinsics => ({
    f: { x: F, y: F },
    c: { x: W / 2 + cxShift, y: H / 2 },
  });
  return { L: mk(-shift), R: mk(+shift) };
}

/** cv::reprojectImageTo3D per pixel: Q·[u v d 1]ᵀ, divide by W. */
function reprojectZ(Q: Float64Array, u: number, v: number, d: number): number {
  const Z = Q[8]! * u + Q[9]! * v + Q[10]! * d + Q[11]!;
  const Wq = Q[12]! * u + Q[13]! * v + Q[14]! * d + Q[15]!;
  return Z / Wq;
}

describe("createQMatrix (principal-point sign)", () => {
  it("reprojects ZERO disparity to the fixation distance (sign + magnitude)", () => {
    const { L, R } = convergedIntrinsics(Z_FIX);
    const Q = createQMatrix(L, R, B);
    const z = reprojectZ(Q, W / 2, H / 2, 0);
    // Pins the sign: reprojection at the principal point returns +Z_FIX.
    expect(z).toBeCloseTo(Z_FIX, 6);
    expect(z).toBeGreaterThan(0);
  });

  it("maps positive disparity NEARER and d → −fB/z to far (asymptote)", () => {
    const { L, R } = convergedIntrinsics(Z_FIX);
    const Q = createQMatrix(L, R, B);
    // d = +fB/z doubles the convergence term → half the fixation distance.
    const dHalf = (F * B) / Z_FIX;
    expect(reprojectZ(Q, W / 2, H / 2, dHalf)).toBeCloseTo(Z_FIX / 2, 6);
    // Approaching d = −fB/z from above → Z → far (large positive), never
    // flipping sign before the asymptote.
    const dAsym = -(F * B) / Z_FIX;
    const zNearAsym = reprojectZ(Q, W / 2, H / 2, dAsym * 0.999);
    expect(zNearAsym).toBeGreaterThan(100 * Z_FIX);
    const monotone = [0, 0.25, 0.5, 0.75, 0.95].map((k) =>
      reprojectZ(Q, W / 2, H / 2, dAsym * k),
    );
    for (let i = 1; i < monotone.length; i++) {
      expect(monotone[i]!).toBeGreaterThan(monotone[i - 1]!); // farther as d ↓
      expect(monotone[i]!).toBeGreaterThan(0);
    }
  });

  it("parallel gaze (equal centers) degenerates to the classic Z = fB/d", () => {
    const mk = (): FoveaIntrinsics => ({ f: { x: F, y: F }, c: { x: W / 2, y: H / 2 } });
    const Q = createQMatrix(mk(), mk(), B);
    expect(reprojectZ(Q, W / 2, H / 2, (F * B) / 500)).toBeCloseTo(500, 6);
    expect(reprojectZ(Q, W / 2, H / 2, (F * B) / 2000)).toBeCloseTo(2000, 6);
  });

  it("matches the full inverseTriangulate → intrinsics → Q chain", () => {
    // Build the intrinsics from the ACTUAL inverseTriangulate angles instead
    // of the closed form — guards the fixture itself against drift.
    const { l, r } = inverseTriangulate({ x: 0, y: 0 }, B, Z_FIX);
    const mk = (a: number): FoveaIntrinsics => ({
      f: { x: F, y: F },
      // deriveFoveaIntrinsics with an ideal pinhole: delta = tan(a)·f.
      c: { x: W / 2 - Math.tan(a) * F, y: H / 2 },
    });
    const Q = createQMatrix(mk(l.x), mk(r.x), B);
    expect(reprojectZ(Q, W / 2, H / 2, 0)).toBeCloseTo(Z_FIX, 6);
  });
});

describe("vergenceToDistance (exact symmetric inverse)", () => {
  it("round-trips inverseTriangulate exactly on the gaze axis", () => {
    for (const z of [120, 500, 800, 3000, 25_000]) {
      const { l, r } = inverseTriangulate({ x: 0, y: 0 }, B, z);
      expect(vergenceToDistance(l.x - r.x, B)).toBeCloseTo(z, 8);
    }
  });

  it("guards parallel/diverging and absurd magnitudes with Infinity", () => {
    expect(vergenceToDistance(0, B)).toBe(Infinity);
    expect(vergenceToDistance(-0.05, B)).toBe(Infinity); // diverging
    expect(vergenceToDistance(1e-12, B)).toBe(Infinity); // absurd magnitude
  });

  it("stays consistent with the verge command algebra", () => {
    // commanded distance (vergeToDistance) → angles → realized distance
    for (const verge of [0.1, 0.25, 0.5]) {
      const z = vergeToDistance(verge, B);
      const { l, r } = inverseTriangulate({ x: 0, y: 0 }, B, z);
      const realized = vergenceToDistance(l.x - r.x, B);
      expect(realized).toBeCloseTo(z, 6);
      expect(distanceToVerge(realized, B)).toBeCloseTo(verge, 8);
    }
  });
});
