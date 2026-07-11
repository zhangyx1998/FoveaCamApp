// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE "live capture session active" banner state machine (unit-tested): warns
// that decode/export competes with a live hardware session. Dismiss is
// per-window, per-episode — re-arms when the session clears.
// spec: docs/spec/viewer.md#export

export interface BannerState {
  /** Is a live capture (hardware) app session currently active? */
  active: boolean;
  /** Did the user dismiss the CURRENT active episode? Cleared when `active`
   *  goes false, so the next episode re-arms. */
  dismissed: boolean;
}

export const initialBannerState: BannerState = { active: false, dismissed: false };

/** Set the condition. A false→true edge does NOT clear a prior dismissal only
 *  if the dismissal belonged to a still-current episode — but because a
 *  dismissal is cleared the moment the condition goes false, any true here after
 *  a real clear starts a fresh (un-dismissed) episode. Idempotent for repeated
 *  same-value sets. */
export function setActive(state: BannerState, active: boolean): BannerState {
  if (active === state.active) return state;
  // Clear on the transition to inactive (episode ends → re-arm); a transition to
  // active keeps `dismissed` false (it was cleared at the previous clear).
  return { active, dismissed: active ? state.dismissed : false };
}

/** User dismissed the banner. Only meaningful while active (a dismiss with no
 *  active episode is a no-op). */
export function dismiss(state: BannerState): BannerState {
  if (!state.active || state.dismissed) return state;
  return { ...state, dismissed: true };
}

/** Should the banner be visible? Active AND not dismissed for this episode. */
export function bannerVisible(state: BannerState): boolean {
  return state.active && !state.dismissed;
}
