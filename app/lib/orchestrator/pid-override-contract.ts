// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Reusable PID-override contract FRAGMENT: the single, module-agnostic definition of the
// state field + command exposing a PID node's override slot across the
// orchestrator↔renderer boundary, factored out so any module gets the identical shape.
// Strictly Vue-free (imports only @lib/orchestrator/protocol) since module contracts are
// imported by the orchestrator bundle too. Consumer usePidOverride lives in the client
// lib; the orchestrator mapping applyPidOverride lives in @orchestrator/pid-node.
// spec: docs/spec/orchestrator-protocol.md#pid-override-contract

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
