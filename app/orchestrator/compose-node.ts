// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Graph-visible PREDICTION COMPOSE NODE (docs/proposals/prediction-compose-
// node.md — ruling 1). The topology the proposal mandates is:
//
//   kcf ──(measurements ~60 Hz)──→ imm (native, rate_hz) ──→ compose ──→ controller
//    └───(target ~60 Hz)─────────→ pid ────────────────────────────────→ compose
//
// The pid node keeps producing ABSOLUTE volts `V_pid` at camera rate from the
// MEASURED target it acted on; this node composes that ~60 Hz baseline with the
// high-rate IMM predictions into the mirror position-input at the PREDICTION
// rate (default 600 Hz), applying a FEED-FORWARD delta in VOLT space:
//
//   V(t) = V_pid + J·(p_pred(t) − p_meas(t_pid))
//
// where `J` is the pixel→volt sensitivity at the current pose. Rather than form
// an explicit Jacobian, the session passes the SAME pure pixel→volt map it
// already owns (`followVolts`) evaluated at both points — `follow(p_pred) −
// follow(p_meas)` is J·Δp to first order (the pose/vergence terms cancel in the
// difference), so the delta math here stays a PURE, unit-tested function
// ({@link composeVolts}).
//
// Two responsibilities beyond the math (same as the pid/imm nodes):
//  1. TOPOLOGY — registers the `imm → compose` input edge (imm is a native
//     brick that does NOT self-report its outgoing edge) and the
//     `compose → controller` output edge; the `pid → compose` edge rides the
//     pid node's `outputs` (edge ownership by the consumer). `dispose()` retires
//     the wiring.
//  2. SELF-METER — `rebase()` counts one `pid` arrival (~60 Hz baseline); each
//     `tick()` counts one `imm` arrival + one `volt` emit (~600 Hz), so every
//     edge reads a truthful rate (the pid-node "emit one unit per output" rule).
//
// BEHAVIOR (proposal §Orchestrator/app): feed-forward ONLY while control is
// healthy. The SESSION decides health (pid override drag → pass the override
// volts through untouched; lost-gate / no calibration / a coasted miss → hold
// the `V_pid` baseline) and expresses it by passing `predVolts = null` to
// `tick()`, which then returns the held baseline. Every new pid result REBASES
// the baseline (and the measured operating point) via `rebase()`.

import {
  registerGraphWiring,
  type GraphWiring,
} from "./graph-topology.js";
import { registerWorkload } from "./metering.js";
import type {
  NodeReport,
  StreamType,
} from "@lib/orchestrator/graph-contract.js";
import type { Pos } from "@lib/controller-codec";

/** A commanded per-eye mirror pose in VOLTS — the value flowing pid → compose →
 *  controller. Structurally identical to disparity-scope's `VergenceVolts`. */
export interface ComposeVolts {
  l: Pos;
  r: Pos;
}

/** Default control-edge type (scalars — no frame on the control path). */
const PID_STREAM: StreamType = { kind: "analysis", schema: "pid" };
/** The IMM prediction stream type (TrackResult-shaped predictions). */
const TRACK_STREAM: StreamType = { kind: "track" };

/**
 * The FEED-FORWARD compose, PURE and unit-tested. `V(t) = V_pid + J·Δp` with
 * the Jacobian supplied implicitly as the pixel→volt map evaluated at both
 * points: `predVolts = follow(p_pred)`, `measVolts = follow(p_meas)`. Per eye,
 * per axis: `baseline + (pred − meas)`. When the caller has no feed-forward to
 * apply (override / lost / no calibration / miss) it passes `predVolts = null`
 * and the baseline is returned UNCHANGED (pass-through / hold).
 */
export function composeVolts(
  baseline: ComposeVolts,
  predVolts: ComposeVolts | null,
  measVolts: ComposeVolts | null,
): ComposeVolts {
  if (!predVolts || !measVolts) return baseline; // hold baseline (no feed-forward)
  return {
    l: {
      x: baseline.l.x + (predVolts.l.x - measVolts.l.x),
      y: baseline.l.y + (predVolts.l.y - measVolts.l.y),
    },
    r: {
      x: baseline.r.x + (predVolts.r.x - measVolts.r.x),
      y: baseline.r.y + (predVolts.r.y - measVolts.r.y),
    },
  };
}

export interface ComposeNodeOptions {
  /** Node id — build via `nodeId.win(windowId, "compose")` (never inline). */
  id: string;
  /** Composing owner (`win/<windowId>`) — surfaces node ownership. */
  owner?: string;
  /** The pid node id (the `pid → compose` edge is the pid node's output — NOT
   *  registered here; declared as an input in `report()` only). */
  pidId: string;
  /** The imm brick node id (the `imm → compose` edge — registered here, since
   *  the native brick does not self-report its outgoing edge). */
  immId: string;
  /** The downstream controller node id (`compose → controller` output edge). */
  controllerId: string;
  /** Input port names on this node for the pid/imm edges. */
  pidPort?: string;
  immPort?: string;
  /** Output port on the controller (`compose → controller` edge port). */
  outPort?: string;
  /** Initial baseline volts (the parked command before the first pid result). */
  initial: ComposeVolts;
}

export interface ComposeNodeHandle {
  readonly id: string;
  /** REBASE the feed-forward baseline from a fresh pid result: `V_pid` +
   *  the measured operating point (`follow(p_meas)`, or null when no pixel→volt
   *  map is available → no feed-forward). Meters one `pid` arrival. */
  rebase(vPid: ComposeVolts, measVolts: ComposeVolts | null): void;
  /** One prediction tick: apply the feed-forward (`predVolts = follow(p_pred)`)
   *  onto the current baseline, or HOLD the baseline when `predVolts` is null
   *  (override / lost / miss). Meters one `imm` arrival + one `volt` emit and
   *  returns the volts to push to the controller position input. */
  tick(predVolts: ComposeVolts | null): ComposeVolts;
  /** The current baseline (pid command) — the value held when no feed-forward
   *  applies; read for telemetry / the parked push. */
  readonly baseline: ComposeVolts;
  report(): NodeReport;
  dispose(): void;
}

/**
 * Create the graph-visible compose node. Registers its topology wiring +
 * self-meter immediately; `dispose()` retires both.
 */
export function createComposeNode(opts: ComposeNodeOptions): ComposeNodeHandle {
  const { id, owner, pidId, immId, controllerId, initial } = opts;
  const pidPort = opts.pidPort ?? "pid";
  const immPort = opts.immPort ?? "imm";
  const outPort = opts.outPort ?? "volt";

  let baseline: ComposeVolts = clone(initial);
  let measVolts: ComposeVolts | null = null;

  const wiring: GraphWiring = {
    nodes: [
      {
        id,
        kind: "compose",
        ...(owner !== undefined ? { owner } : {}),
        output: PID_STREAM,
        transport: "native",
      },
    ],
    edges: [
      // imm → compose (INTO this node — the native brick doesn't self-report it).
      { from: immId, to: id, port: immPort, type: TRACK_STREAM },
      // compose → controller (this node's OUTPUT edge). The pid → compose edge
      // is the pid node's output (edge ownership by the consumer).
      { from: id, to: controllerId, port: outPort, type: PID_STREAM },
    ],
  };
  const unregister = registerGraphWiring(wiring);

  // Self-meter: `pid` (baseline rebase, ~60 Hz), `imm` (prediction tick,
  // ~600 Hz), `volt` (the push to the controller, ~600 Hz).
  const meter = registerWorkload(id, {
    inputs: [pidPort, immPort],
    outputs: [outPort],
  });

  return {
    id,
    rebase(vPid: ComposeVolts, m: ComposeVolts | null): void {
      baseline = clone(vPid);
      measVolts = m ? clone(m) : null;
      meter.ingest(pidPort);
    },
    tick(predVolts: ComposeVolts | null): ComposeVolts {
      meter.ingest(immPort);
      const out = composeVolts(baseline, predVolts, measVolts);
      meter.emit(outPort);
      return out;
    },
    get baseline() {
      return baseline;
    },
    report(): NodeReport {
      return {
        id,
        kind: "compose",
        transport: "native",
        ...(owner !== undefined ? { owner } : {}),
        output: PID_STREAM,
        inputs: [
          { from: pidId, port: pidPort, type: PID_STREAM },
          { from: immId, port: immPort, type: TRACK_STREAM },
        ],
      };
    },
    dispose(): void {
      meter.dispose();
      unregister();
    },
  };
}

function clone(v: ComposeVolts): ComposeVolts {
  return { l: { x: v.l.x, y: v.l.y }, r: { x: v.r.x, y: v.r.y } };
}
