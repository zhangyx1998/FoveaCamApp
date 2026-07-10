// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Graph-visible IMM motion-predictor NODE (docs/proposals/imm-delay-
// compensation.md). It sits BETWEEN the chained tracker and the PID node so
// the LR topology reads `kcf → imm → pid`: it consumes each tracker
// `TrackResult` and forwards the SAME shape with `center`/`bbox` replaced by
// the state propagated to `t_result + delayMs` (the pure math lives in
// `@lib/imm-predictor`, unit-tested there). Mirrors `@orchestrator/pid-node`'s
// two responsibilities beyond the math:
//
//  1. TOPOLOGY — registers a `registerGraphWiring` entry for the node + its
//     `tracker → imm` INCOMING edge (the `imm → pid` edge is the pid node's
//     input, registered there — edge ownership by the consumer, exactly as the
//     old `kcf → pid` edge was). `dispose()` retires it.
//  2. SELF-METER — one `registerWorkload` unit emitted per prediction so the
//     `kcf → imm` (rx) and `imm → pid` (tx) edge rates read truthfully (the
//     same "emit one unit per output" rule the pid node's meter comment states;
//     without it the imm → pid edge would read a false 0 Hz).

import {
  ImmPredictor,
  type ImmPredictorConfig,
} from "@lib/imm-predictor.js";
import {
  registerGraphWiring,
  type GraphWiring,
} from "./graph-topology.js";
import { registerWorkload } from "./metering.js";
import type { NodeReport, StreamType } from "@lib/orchestrator/graph-contract.js";
import type { TrackResult } from "core/Tracker";

/** The KCF/hybrid track stream type — the imm node's in AND out edge type. */
const TRACK_STREAM: StreamType = { kind: "track" };

export interface ImmNodeOptions {
  /** Node id — build via `nodeId.imm(trackerId)` (never inline). */
  id: string;
  /** Composing owner (`win/<windowId>`) — surfaces node ownership. */
  owner?: string;
  /** The upstream tracker node id (the `tracker → imm` edge source). */
  trackerId: string;
  /** Port name for the tracker → imm → pid edges (matches the pid input). */
  port: string;
  /** IMM filter configuration (per-triple `delayCompensationMs` + tuning). */
  config: ImmPredictorConfig;
}

export interface ImmNodeHandle {
  readonly id: string;
  /** Run one tracker result through the predictor + meter it. Returns the
   *  (possibly rewritten) result to forward downstream. */
  process(r: TrackResult): TrackResult;
  /** Reset the filter dynamics (drag/teardown boundaries own by the caller;
   *  the predictor also self-resets on overridden results). */
  reset(): void;
  report(): NodeReport;
  dispose(): void;
}

/**
 * Create the graph-visible IMM predictor node. Registers its topology wiring +
 * self-meter immediately; `dispose()` retires both.
 */
export function createImmNode(opts: ImmNodeOptions): ImmNodeHandle {
  const { id, owner, trackerId, port, config } = opts;
  const predictor = new ImmPredictor(config);

  const wiring: GraphWiring = {
    nodes: [
      {
        id,
        kind: "imm",
        ...(owner !== undefined ? { owner } : {}),
        output: TRACK_STREAM,
        transport: "native",
      },
    ],
    edges: [
      // tracker → imm (INTO this node). The imm → pid edge rides the pid
      // node's inputs (edge ownership by the consumer).
      { from: trackerId, to: id, port, type: TRACK_STREAM },
    ],
  };
  const unregister = registerGraphWiring(wiring);

  // Self-meter keyed by the node id: one unit in + one out per prediction, so
  // both the kcf → imm and imm → pid edge rates are truthful (pid-node meter
  // rule). `measure` wraps the filter step for busy time / utilization.
  const meter = registerWorkload(id, { inputs: [port], outputs: [port] });

  return {
    id,
    process(r: TrackResult): TrackResult {
      meter.ingest(port);
      const out = meter.measure(() => predictor.process(r));
      meter.emit(port);
      return out;
    },
    reset(): void {
      predictor.reset();
    },
    report(): NodeReport {
      return {
        id,
        kind: "imm",
        transport: "native",
        ...(owner !== undefined ? { owner } : {}),
        output: TRACK_STREAM,
        inputs: [{ from: trackerId, port, type: TRACK_STREAM }],
      };
    },
    dispose(): void {
      meter.dispose();
      unregister();
    },
  };
}
