// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Manual-control "split fovea" state — pure, session-local, NOT persisted: the
// tiny per-eye override precedence rule (override > unified), unit-testable
// without a live session. Behavior spec: docs/spec/manual-control.md §split.

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
