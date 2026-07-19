// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The prediction-compose feed-forward math — the JS CONFORMANCE REFERENCE for the
// native ComposeStream brick (imm → compose → controller). The form is
// V(t) = V_pid + J·(p_pred(t) − p_meas(t_pid)), expressed here as predVolts − measVolts
// over a pixel→volt map (identical to J·Δp for the linear Jacobian the brick receives);
// the fixture (docs/schema/codec/compose-vectors.json) pins the two forms equal.
// spec: docs/spec/controller.md#compose-reference

import type { Pos } from "@lib/controller-codec";

/** A commanded per-eye mirror pose in VOLTS. Structurally identical to
 *  disparity-scope's `VergenceVolts`. */
export interface ComposeVolts {
  l: Pos;
  r: Pos;
}

/**
 * The FEED-FORWARD compose, PURE and unit-tested. `V(t) = V_pid + J·Δp` with
 * the Jacobian supplied implicitly as the pixel→volt map evaluated at both
 * points: `predVolts = follow(p_pred)`, `measVolts = follow(p_meas)`. Per eye,
 * per axis: `baseline + (pred − meas)`. When the caller has no feed-forward to
 * apply (override / lost / no calibration / miss) it passes `predVolts = null`
 * and the baseline is returned UNCHANGED (pass-through / hold).
 */
export function composeVolts(
  baseline: ComposeVolts,
  predVolts: ComposeVolts | null,
  measVolts: ComposeVolts | null,
): ComposeVolts {
  if (!predVolts || !measVolts) return baseline; // hold baseline (no feed-forward)
  return {
    l: {
      x: baseline.l.x + (predVolts.l.x - measVolts.l.x),
      y: baseline.l.y + (predVolts.l.y - measVolts.l.y),
    },
    r: {
      x: baseline.r.x + (predVolts.r.x - measVolts.r.x),
      y: baseline.r.y + (predVolts.r.y - measVolts.r.y),
    },
  };
}
