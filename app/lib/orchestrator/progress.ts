// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator spin-up progress model (user ruling 2026-07-09): app windows
// blank out during session activation/graph building with no indicator. A
// session declares an UPFRONT list of steps at the start of its activation and
// transitions each one (pending → active → done) as it works; the list rides
// the per-session STATUS channel (`SessionStatus.progress`, see protocol.ts) so
// every subscribed window can render a progress overlay generically — no typed
// contract per app.
//
// This module is renderer-SAFE and Vue-FREE on purpose: the type ships to the
// renderer client, the protocol wire type references `ProgressItem`, and the
// server runtime builds/mutates the list. It must stay a LEAF (no import of
// runtime.ts / protocol.ts) so `SessionStatus` in protocol.ts can reference
// `ProgressItem` without an import cycle.

export type ProgressState = "pending" | "active" | "done";

/** One declared spin-up step, as it crosses the status channel. */
export type ProgressItem = {
  id: string;
  label: string;
  state: ProgressState;
};

/** A step as DECLARED by a session (no state yet — the list seeds `pending`). */
export type ProgressStep = { id: string; label: string };

/**
 * The handle a session's `progressMonitor(steps)` hands back. Declaring
 * publishes the full pending list immediately; `start`/`done` publish single
 * state transitions; `complete` clears the list (progress → null). A failure
 * path deliberately calls NEITHER `done` nor `complete` — leaving the list
 * frozen shows the user WHERE spin-up died (the error surfaces separately on
 * the same status channel).
 */
export interface ProgressMonitor {
  /** Mark a step ACTIVE (the work for it has begun). */
  start(id: string): void;
  /** Mark a step DONE (its work finished). */
  done(id: string): void;
  /** Spin-up finished — clear the overlay (progress → null). */
  complete(): void;
}

/** Seed the declared steps into a fresh all-`pending` list. */
export function pendingList(steps: readonly ProgressStep[]): ProgressItem[] {
  return steps.map((s) => ({ id: s.id, label: s.label, state: "pending" }));
}

/** Return a COPY of `items` with `id`'s state set to `state` (others intact).
 *  A missing id is a no-op copy — a mistyped step id can't corrupt the list. */
export function withStepState(
  items: readonly ProgressItem[],
  id: string,
  state: ProgressState,
): ProgressItem[] {
  return items.map((it) => (it.id === id ? { ...it, state } : { ...it }));
}
