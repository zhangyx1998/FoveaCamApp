// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Per-eye pixel→volt Jacobian for the split-tracking visual servo — the PURE
// geometric core the session finite-differences at each tick (extracted so it
// unit-tests without the native addon; the session supplies the calibration
// objects). Same finite-difference BASIS as disparity-scope's `followVolts`
// Jacobian, reduced to ONE eye and to the FOVEA image frame.
//
// Model (NO hardware — it is the calibration model):
//   A target at fovea-image pixel offset `p` from the frame center sits at gaze
//   angle `angle0 + p / focal` (small-angle pinhole, per axis). To bring it to
//   the fovea center the mirror must gaze at that angle, so the commanded volt
//   is `A2V(angle0 + p / focal)`. The pixel→volt Jacobian is therefore
//   `d/dp [ A2V(angle0 + p/focal) ]` — a finite difference around `p = 0`,
//   which already yields VOLT-PER-PIXEL directly (no explicit matrix inverse:
//   differentiating the volt(px) map IS the "inverse" of the px(volt) map).
//
// RIG-TUNABLE: the per-axis SIGN (`signX`/`signY`) and the effective focal
// SCALE (via the caller's `zoom` into `deriveFoveaIntrinsics`) depend on the
// fovea camera↔mirror mounting (image flips, warp magnification). The pinhole
// defaults below (+1, +1) are the naive convention; the stage-f servo pass
// pins the true signs/scale. Everything here is deterministic geometry.

import type { Point2d } from "core/Geometry";
import type { Mat2 } from "./tracking";

export interface EyeJInvInputs {
  /** Fovea intrinsic focal (px per radian, per axis) — `deriveFoveaIntrinsics().f`. */
  focal: Point2d;
  /** Current gaze angle (rad) for this eye — `conv.V2A[eye](volt)`. */
  angle0: Point2d;
  /** This eye's angle→volt regression — `conv.A2V[eye]`. */
  a2v(angle: Point2d): Point2d;
  /** RIG-TUNABLE per-axis pixel→angle sign (default +1). */
  signX?: number;
  signY?: number;
  /** Finite-difference step in pixels (default 1). */
  epsPx?: number;
}

/** 2×2 volt-per-px inverse Jacobian `[a,b,c,d]` (row-major `[[a,b],[c,d]]`) such
 *  that `applyJInv(errPx, jInv)` gives the volt DELTA that recenters `errPx`.
 *  Degenerate (all-zero) focal ⇒ zero matrix (servo holds — no divide blowup). */
export function eyeJInv(inp: EyeJInvInputs): Mat2 {
  const { focal, angle0, a2v } = inp;
  const sx = inp.signX ?? 1;
  const sy = inp.signY ?? 1;
  const eps = inp.epsPx ?? 1;
  // Guard a zero/degenerate focal — an uncalibrated or unresolved intrinsic
  // must not inject Infinity/NaN into the mirror command.
  if (!Number.isFinite(focal.x) || !Number.isFinite(focal.y) || focal.x === 0 || focal.y === 0)
    return [0, 0, 0, 0];

  const angleAt = (dp: Point2d): Point2d => ({
    x: angle0.x + (sx * dp.x) / focal.x,
    y: angle0.y + (sy * dp.y) / focal.y,
  });

  const v0 = a2v(angle0);
  const vx = a2v(angleAt({ x: eps, y: 0 })); // +eps in px_x
  const vy = a2v(angleAt({ x: 0, y: eps })); // +eps in px_y

  // Columns are the per-pixel-axis volt gradients; rows map to volt axes.
  //   a = dVx/dpx_x   b = dVx/dpx_y
  //   c = dVy/dpx_x   d = dVy/dpx_y
  return [
    (vx.x - v0.x) / eps,
    (vy.x - v0.x) / eps,
    (vx.y - v0.y) / eps,
    (vy.y - v0.y) / eps,
  ];
}
