// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Graph-visible PID controller NODE (docs/proposals/pid-nodes-and-view-replumb.md
// §"PID node design (worker A)"). The control math a module already ran inline
// (e.g. disparity-scope's `stepVergence`) becomes a first-class node in the
// stream topology: it consumes an upstream analysis result (the scope's
// projected fovea centers) and produces a command for a downstream node (the
// MEMS `controller/<port>`). This is NOT per-frame JS work — it runs scalar
// controllers at the upstream RESULT rate, so the thin-coordinator rule
// (MEMORY: "orchestrator = thin coordinator") holds: the node forwards a final
// result, it does not micro-manage frames.
//
// Two responsibilities beyond "hold some PIDs":
//
//  1. TOPOLOGY — on creation it registers a `registerGraphWiring` entry (the
//     C-24 stage-1 shim, same mechanism disparity-scope uses for its kernel) so
//     the node + its scope→pid and pid→controller edges show in the profiler
//     graph; `dispose()` retires it. `report()` returns the equivalent
//     `NodeReport` (the direct self-report path the shim migrates to).
//
//  2. OVERRIDE — a renderer-driven slot (`usePidOverride` proxy → a module
//     command → here) that PINS the output. The ruled semantics are exact:
//     while engaged, `step()` SKIPS the control fn and RESETS every named
//     controller each tick (state held at zero, so windup can't accumulate
//     behind the override); the output IS the override value. On `release()`
//     the caller-supplied `seed(lastOverride)` reseeds the controllers from the
//     last override — with the velocity-form integrator that gives output
//     CONTINUITY (no jump), reproducing "resume control from where the drag
//     left the mirrors".

import type { PID, PID2D } from "@lib/pid.js";
import {
  registerGraphWiring,
  type GraphWiring,
} from "./graph-topology.js";
import type {
  NodeReport,
  StreamType,
} from "@lib/orchestrator/graph-contract.js";
import type {
  PidOverrideCommand,
  PidOverrideState,
} from "@lib/orchestrator/pid-override-contract.js";

/** Any named controller a node holds — scalar or 2D; both expose `reset()`. */
export type Controller = PID | PID2D;

/** An edge INTO the node (its analysis input, e.g. the scope's projection). */
export interface PidNodeInput {
  from: string;
  port: string;
  /** Stream type of the edge (defaults to an analysis stream tagged `pid`). */
  type?: StreamType;
}

/** An edge OUT of the node (into a downstream consumer, e.g. the controller). */
export interface PidNodeOutput {
  to: string;
  port: string;
  type?: StreamType;
}

export interface PidNodeOptions<V> {
  /** Node id — build via `nodeId.win(windowId, "pid")` (never inline). */
  id: string;
  kind: "pid";
  /** Composing owner (`win/<windowId>`), if any — surfaces node ownership. */
  owner?: string;
  /** Live input edges (topology only — the node reads its result via `step`). */
  inputs: PidNodeInput[];
  /** Live output edges (topology only — the caller forwards `step`'s result). */
  outputs: PidNodeOutput[];
  /** The named DOFs this node integrates (reset together while overridden). */
  controllers: Record<string, Controller>;
  /** Advertised output stream type (default analysis/"pid"). */
  output?: StreamType;
  /**
   * Release hook: reseed the controllers from the LAST override value so the
   * resumed control output is continuous. Invoked by `override.release()` with
   * the value the slot held at release. Omit only if a jump on release is
   * acceptable — the directive requires it for the drag path.
   */
  seed?: (lastOverride: V) => void;
}

/**
 * What `step()` returns while the override is ENGAGED: a marker carrying the
 * override value, distinct from a plain `V` (which means the control fn ran
 * normally). Callers that only need the command use {@link outputOf}; callers
 * that must know whether control was bypassed check {@link isOverrideHeld}
 * (or read `handle.override.engaged`).
 */
export type OverrideHeld<V> = { held: true; value: V };

export function isOverrideHeld<V>(r: V | OverrideHeld<V>): r is OverrideHeld<V> {
  return (
    typeof r === "object" &&
    r !== null &&
    (r as { held?: unknown }).held === true
  );
}

/** The command output regardless of whether the override was engaged. */
export function outputOf<V>(r: V | OverrideHeld<V>): V {
  return isOverrideHeld(r) ? r.value : r;
}

/**
 * The renderer-facing override handle. `engage`/`update` are the same
 * (idempotent engage — the slot has no "already engaged" error state); the wire
 * command collapses to whichever the module maps them to. `release()` clears
 * the slot and runs the node's `seed`.
 */
export interface OverrideSlot<V> {
  readonly engaged: boolean;
  /** Current override value (null while released). */
  readonly value: V | null;
  /** Engage the override at `v` (or move it there while already engaged). */
  engage(v: V): void;
  /** Alias of {@link engage} — reads as "update the pinned value". */
  update(v: V): void;
  /** Release: clear the slot, then reseed the controllers via the node's
   *  `seed` hook so control resumes continuously. No-op when not engaged. */
  release(): void;
}

export interface PidNodeHandle<V> {
  readonly id: string;
  /** Run one control step: `fn` computes the command from the upstream result,
   *  UNLESS the override is engaged — then `fn` is skipped, every controller is
   *  reset, and the pinned override value is returned (wrapped as
   *  {@link OverrideHeld}). Use {@link outputOf} to get the command either way. */
  step(fn: () => V): V | OverrideHeld<V>;
  readonly override: OverrideSlot<V>;
  /** The node's self-report (inputs = incoming edges; the outgoing edge is the
   *  consumer's input, registered via the wiring shim). */
  report(): NodeReport;
  /** Retire the topology wiring entry. */
  dispose(): void;
}

/** Default stream type for a control edge — a named analysis record (there is
 *  no frame on the control path; the scope→pid→controller links carry scalars). */
const PID_STREAM: StreamType = { kind: "analysis", schema: "pid" };

/**
 * Create a graph-visible PID controller node. Generic over the override/output
 * value type `V` (the same type flows through `override.engage(v)`, the `seed`
 * hook, and `step`'s return). Registers its topology wiring immediately;
 * `dispose()` retires it.
 */
export function createPidNode<V>(opts: PidNodeOptions<V>): PidNodeHandle<V> {
  const { id, kind, owner, controllers, seed } = opts;
  const output = opts.output ?? PID_STREAM;
  const controllerList = Object.values(controllers);

  // --- override slot ---------------------------------------------------------
  let engaged = false;
  let value: V | null = null;

  const engage = (v: V): void => {
    engaged = true;
    value = v;
  };
  const override: OverrideSlot<V> = {
    get engaged() {
      return engaged;
    },
    get value() {
      return value;
    },
    engage,
    update: engage, // idempotent engage — same transition, clearer intent
    release() {
      if (!engaged) return;
      // Capture BEFORE clearing so `seed` sees the value the slot held.
      const last = value as V;
      engaged = false;
      value = null;
      seed?.(last);
    },
  };

  // --- topology wiring (C-24 stage-1 shim) -----------------------------------
  const inputType = (i: PidNodeInput): StreamType => i.type ?? PID_STREAM;
  const wiring: GraphWiring = {
    nodes: [
      {
        id,
        kind,
        ...(owner !== undefined ? { owner } : {}),
        output,
        transport: "native",
      },
    ],
    edges: [
      // scope → pid (edge INTO this node)
      ...opts.inputs.map((i) => ({
        from: i.from,
        to: id,
        port: i.port,
        type: inputType(i),
      })),
      // pid → controller (edge into the DOWNSTREAM node; the shim files it
      // under that node's inputs, creating a placeholder if it isn't declared).
      ...opts.outputs.map((o) => ({
        from: id,
        to: o.to,
        port: o.port,
        type: o.type ?? output,
      })),
    ],
  };
  const unregister = registerGraphWiring(wiring);

  return {
    id,
    step(fn: () => V): V | OverrideHeld<V> {
      if (engaged) {
        // Hold every controller reset each tick so no windup builds behind the
        // override; the output is the pinned value, not a computed command.
        for (const c of controllerList) c.reset();
        return { held: true, value: value as V };
      }
      return fn();
    },
    override,
    report(): NodeReport {
      return {
        id,
        kind,
        transport: "native",
        ...(owner !== undefined ? { owner } : {}),
        output,
        // NodeReport carries only INCOMING edges (the outgoing edge is the
        // consumer's input) — mirrors the wiring's input half.
        inputs: opts.inputs.map((i) => ({
          from: i.from,
          port: i.port,
          type: inputType(i),
        })),
      };
    },
    dispose() {
      unregister();
    },
  };
}

/**
 * Server-side mapping from a {@link PidOverrideCommand} to the slot, returning
 * the fresh {@link PidOverrideState} for the module to `setState`. Keeps the
 * engage/update/release wiring identical across modules (deliverable 3's
 * "reusable by any module"): a module's command handler is one line —
 * `return applyPidOverride(node.override, arg)` followed by mirroring the
 * result into contract state.
 */
export function applyPidOverride<V>(
  slot: OverrideSlot<V>,
  command: PidOverrideCommand<V>,
): PidOverrideState<V> {
  if ("release" in command && command.release) slot.release();
  else if ("value" in command) slot.engage(command.value);
  return { engaged: slot.engaged, value: slot.value };
}
