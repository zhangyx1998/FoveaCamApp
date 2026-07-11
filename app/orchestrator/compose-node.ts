// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The prediction-compose FEED-FORWARD math — the JS CONFORMANCE REFERENCE
// (docs/proposals/native-compose-controller.md). The wave-1 graph node that
// lived here (`createComposeNode`) is RETIRED: the compose is now the NATIVE
// `ComposeStream` brick (core/src/ComposeStream.cpp) piped imm → compose →
// controller, and its per-tick math must reproduce THIS function on the
// shared vectors (docs/schema/codec/compose-vectors.json) — the same
// TS-reference pattern as `@lib/imm-predictor` for the IMM brick.
//
// The ruled form is `V(t) = V_pid + J·(p_pred(t) − p_meas(t_pid))`. This
// reference expresses `J·Δp` as the difference of a pixel→volt map evaluated
// at both points (`predVolts − measVolts`) — for the LINEAR map the native
// brick receives (the session's finite-difference Jacobian at `p_meas`), the
// two forms are identical, which is exactly what the fixture pins.

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
