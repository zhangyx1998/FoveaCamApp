// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Live cross-window state for the extrinsic-calibration OVERLAY toggle
// (calibration-records-v2.md §Overlay). Rides a single store doc — MAIN is the
// config authority now (692f0e3), so a toggle in the Settings window is visible
// LIVE in a running calibrate-extrinsic view (or any StreamView for the target
// camera) with no bespoke IPC. The overlay renderer is the SAME component as the
// standalone visualizer; this doc only says WHICH record to draw and for WHICH
// camera.

/** The store doc backing the overlay toggle (`["ui", "cal-overlay"]`). */
export const OVERLAY_DOC = ["ui", "cal-overlay"];

export interface OverlayState {
  /** The record id whose observed-vs-projected overlay is active (null = off). */
  recordId: string | null;
  /** The camera key the overlay targets — a host renders it only for ITS own
   *  camera, so toggling never bleeds onto an unrelated stream. */
  cameraKey: string | null;
  /** The eye role (`"L"`/`"R"`) the overlay targets — the calibrate-extrinsic
   *  view keys off this (it knows roles, not full camera keys). */
  role: string | null;
}

export const OVERLAY_OFF: OverlayState = { recordId: null, cameraKey: null, role: null };

/** Whether the overlay is on for a given camera. */
export function overlayActiveFor(state: OverlayState, cameraKey: string): boolean {
  return state.recordId != null && state.cameraKey === cameraKey;
}

/** Whether the overlay is on for a given eye role (the calibrate-extrinsic view
 *  matches by role, which it has, rather than full camera key). */
export function overlayActiveForRole(state: OverlayState, role: string): boolean {
  return state.recordId != null && state.role === role;
}
