// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Manual-control "split fovea" state — pure, session-local, NOT persisted.
//
// In MANUAL CONTROL the two eyes normally share one target: `targetVolts()`
// solves L/R from the single steered angle (`inverseTriangulate → A2V`). A drag
// on the L (or R) `PosView` pins THAT eye to a directly-chosen volt-space
// position — the other eye keeps following the unified solution ("holds its
// current command" since nothing else moves it). Any wide-view drag or
// programmatic target set REUNIFIES (clears both overrides). This module holds
// only the tiny precedence rule so it is unit-testable without a live session.

import type { Pos } from "@lib/controller-codec";

/** Per-eye volt override. `null` = that eye follows the unified target. */
export type SplitVolts = { l: Pos | null; r: Pos | null };

/** Fresh unified state — both eyes on the shared solution. */
export function unifiedSplit(): SplitVolts {
  return { l: null, r: null };
}

/** Resolve the volts to command: an eye's override WINS over the unified
 *  solution (override > unified). Null-preserving so an eye with no override
 *  keeps tracking the shared target. */
export function resolveVolts(
  unified: { l: Pos; r: Pos },
  split: SplitVolts,
): { l: Pos; r: Pos } {
  return { l: split.l ?? unified.l, r: split.r ?? unified.r };
}

/** Booleans the UI reads to mark which eyes are steered independently. */
export function splitFlags(split: SplitVolts): { l: boolean; r: boolean } {
  return { l: split.l !== null, r: split.r !== null };
}

/** True while EITHER eye is overridden (the wide-view footprints diverge). */
export function isSplit(split: SplitVolts): boolean {
  return split.l !== null || split.r !== null;
}
