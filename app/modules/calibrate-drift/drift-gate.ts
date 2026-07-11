// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure gating/threshold helpers for calibrate-drift, shared by the session
// (per-eye fovea-lock gate) and the renderer (delta readout + Update noise
// floor). Vue-free so both sides + the unit test share the same rules.

import type { Point2d } from "core/Geometry";

/** The subset of a `MarkerTracker` the gate reads — a live `target` (null when
 *  that fovea's marker isn't currently locked). Structural so the gate unit-
 *  tests against fakes without the native tracker. */
export interface LockState {
  readonly target: unknown | null;
}

/** Gate a derived value on that eye's tracker holding a live marker lock. A
 *  drift derived while the fovea tracker is unlocked is a plausible-looking but
 *  meaningless value (mirror parked at origin) — publish/commit null instead
 *  (regression vs master; the UI enables "Update Drift" off `derived` non-null). */
export function gateOnLock<T>(value: T | null, tracker: LockState | null | undefined): T | null {
  return tracker && tracker.target ? value : null;
}

/** Angular magnitude (radians) of the derived-vs-saved drift delta, treating a
 *  missing saved drift as zero. null when there's no derived value to compare. */
export function driftDelta(derived: Point2d | null, saved: Point2d | null): number | null {
  if (!derived) return null;
  const dx = derived.x - (saved?.x ?? 0);
  const dy = derived.y - (saved?.y ?? 0);
  return Math.hypot(dx, dy);
}

/** Below this angular delta (radians) a re-committed drift is within marker-
 *  tracking measurement noise — committing it is churn, not signal — so the
 *  Update button is disabled. ~0.03° is a deliberately conservative floor;
 *  revisit once the stage-f rig pass measures the real tracker jitter. */
export const DRIFT_NOISE_FLOOR_RAD = 5e-4;

/** Whether a derived drift is worth committing: present AND at least a noise
 *  floor away from what's already saved. */
export function driftUpdatable(derived: Point2d | null, saved: Point2d | null): boolean {
  const d = driftDelta(derived, saved);
  return d !== null && d >= DRIFT_NOISE_FLOOR_RAD;
}
