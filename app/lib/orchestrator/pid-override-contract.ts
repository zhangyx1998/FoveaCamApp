// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Reusable PID-override contract FRAGMENT (docs/proposals/pid-nodes-and-view-
// replumb.md §"Renderer reactive proxy"). A PID controller node can be
// externally OVERRIDDEN from the renderer (a pointer drag pins the output while
// the control law is held reset); this file is the single, module-agnostic
// definition of the state field + command that expose that slot across the
// orchestrator↔renderer boundary — the same role the per-module `contract.ts`
// files play, factored out so ANY module gets the identical shape.
//
// STRICTLY Vue-free (imports only `@lib/orchestrator/protocol`): module
// contracts are imported by the ORCHESTRATOR bundle too, so pulling `vue` in
// here would break the Vue-free-orchestrator rule the same way it did for
// `@lib/pid` (see that file's header). The renderer-side reactive proxy that
// CONSUMES this fragment (`usePidOverride`) lives in the client lib, where Vue
// already ships. The orchestrator-side mapping (`applyPidOverride`) lives in
// `@orchestrator/pid-node`, next to the override slot it drives.

import { cmd, type Command } from "./protocol.js";

/**
 * The serializable override state a module publishes for a PID node, generic
 * over the node's value type `V` (e.g. `{ l, r }` mirror volts for vergence).
 * `engaged` mirrors the server-authoritative slot; `value` is the current
 * override (null while released). This is what the renderer reactive proxy
 * reads back and the actuation path pins its output to.
 */
export type PidOverrideState<V> = { engaged: boolean; value: V | null };

/**
 * The command payload driving the slot: `{ value }` engages OR updates (the
 * slot treats engage as idempotent), `{ release: true }` releases (the node's
 * `seed` hook then makes the resumed control output continuous). One command
 * covers all three transitions so a module wires exactly one handler.
 */
export type PidOverrideCommand<V> = { value: V } | { release: true };

/** Default (released) override state — the seed a contract's `state` uses. */
export function pidOverrideState<V>(): PidOverrideState<V> {
  return { engaged: false, value: null };
}

/** The typed command signature for a contract's `commands` map (phantom value,
 *  types only — see {@link cmd}). */
export function pidOverrideCmd<V>(): Command<PidOverrideCommand<V>, void> {
  return cmd<PidOverrideCommand<V>, void>();
}

/** Default state-key / command-name the renderer proxy and server binder agree
 *  on when a module doesn't override them (a module with a SINGLE PID node just
 *  uses these; multi-node modules pass distinct names). */
export const PID_OVERRIDE_KEYS = {
  state: "pidOverride",
  command: "pidOverride",
} as const;
