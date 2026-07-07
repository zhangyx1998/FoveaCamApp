// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Small, Vue-free primitives shared by the marker-calibration sessions
// (calibrate-extrinsic, calibrate-drift, calibrate-distortion). Each of the
// three independently stood up an identical L/C/R `MarkerTracker` triple,
// the same `target ? { points } : null` detection overlay, the same
// per-tracker `onDetection` wiring, teardown, and `setTargetId` retarget —
// with the tracker scale/dictionary/`internal` constants copy-pasted three
// ways (drift dropping subpixel refinement being the only real difference).
//
// Kept as a toolkit, not a session framework (same discipline as
// `fovea-pipeline.ts`): each session still owns its own intrinsic/extrinsic
// data, actuation mode, view taps, and extra telemetry — these helpers only
// remove the triple + detection-publish + target-id boilerplate so the three
// can't drift on marker id, detector dictionary, or fovea scale.

import { MarkerDetector } from "core/Vision";
import type { Camera } from "core/Aravis";
import type { Point2d } from "core/Geometry";
import { MarkerTracker } from "./marker-tracker.js";

export type Role = "L" | "C" | "R";
export type Roles<T> = Record<Role, T>;
export type TargetIds = Roles<number>;

/** The subset of `MarkerTracker` these primitives touch — kept structural so
 *  the pure helpers unit-test against fakes without the native tracker. */
export interface Tracker {
  targetId: number;
  readonly target: { img_pts: Point2d[] } | null;
  onDetection(fn: () => void): () => void;
  stop(): void;
}

/** Live per-camera detection overlay (matched marker's corner list, or null)
 *  — the shared `DetectionView` shape across the three calibration contracts. */
export type DetectionView = { points: Point2d[] } | null;

const DETECTOR_DICT = "4X4_50";
const FOVEA_SCALE = 0.25;
const WIDE_SCALE = 1.0;

/** Build the standard L/C/R marker-tracker triple: one shared 4X4_50 detector,
 *  fovea L/R at quarter scale, wide C at full scale. `internal` toggles the
 *  fovea trackers' subpixel refinement (extrinsic/distortion want it; drift
 *  doesn't). Target ids come from the session's `target_id` state. */
export function createTrackerTriple(
  cameras: Roles<Camera>,
  targetIds: TargetIds,
  opts: { internal?: boolean } = {},
): Roles<MarkerTracker> {
  const detector = new MarkerDetector(DETECTOR_DICT);
  const internal = opts.internal ?? false;
  return {
    L: new MarkerTracker(cameras.L, detector, targetIds.L, FOVEA_SCALE, internal),
    C: new MarkerTracker(cameras.C, detector, targetIds.C, WIDE_SCALE),
    R: new MarkerTracker(cameras.R, detector, targetIds.R, FOVEA_SCALE, internal),
  };
}

/** The detection overlay one tracker currently exposes. */
export function detectionView(t: Tracker): DetectionView {
  return t.target ? { points: t.target.img_pts } : null;
}

/** L/C/R detection overlays for the `detection` telemetry field. Sessions that
 *  publish extra fields (drift's `center_angle`, …) merge this into their own
 *  telemetry patch. */
export function detectionViews(trackers: Roles<Tracker>): Roles<DetectionView> {
  return {
    L: detectionView(trackers.L),
    C: detectionView(trackers.C),
    R: detectionView(trackers.R),
  };
}

/** Subscribe to each tracker's detection tick, pushing the unsubscribers onto
 *  `disposers`. `onCenter` overrides the wide (C) handler — calibrate-distortion
 *  routes it through its own angle recompute. */
export function bindDetections(
  trackers: Roles<Tracker>,
  disposers: Array<() => void>,
  onDetection: () => void,
  onCenter: () => void = onDetection,
): void {
  disposers.push(trackers.L.onDetection(onDetection));
  disposers.push(trackers.C.onDetection(onCenter));
  disposers.push(trackers.R.onDetection(onDetection));
}

/** Stop all three trackers (idle teardown); returns `null` for the caller to
 *  reassign its triple handle. No-op when already cleared. */
export function stopTriple(trackers: Roles<Tracker> | null): null {
  if (trackers) for (const t of Object.values(trackers)) t.stop();
  return null;
}

/** Retarget one live tracker to a new marker id (the tracker-side half of a
 *  `setTargetId` command; the session still owns its typed `target_id` state). */
export function retarget(trackers: Roles<Tracker> | null, role: Role, id: number): void {
  if (trackers) trackers[role].targetId = id;
}
