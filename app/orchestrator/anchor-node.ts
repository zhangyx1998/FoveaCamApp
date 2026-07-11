// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The anchor enrichment node: a JS, FIN-rate (loop-safe) middle node. Each completed
// controller exposure (FIN FrameOutcome) becomes ONE stage-independent anchor (exposure
// time + stream + enrichment attachments: exposure-averaged volts, V2A angles, per-side
// H) pushed to EVERY registered pairing brick, which echoes the opaque Float64Array back
// in the pair record for the recorder to unpack. Native-free (injected PairAnchorSink
// seam + the triple's CoordinateConversions).
// spec: docs/spec/controller.md#anchor-node

import type { CoordinateConversions } from "@lib/coordinate-conversions";
import type { Pos } from "@lib/controller-codec";
import type { FrameOutcome } from "./controller.js";
import { nodeId } from "@lib/orchestrator/graph-contract.js";
import {
  registerGraphWiring,
  type GraphWiring,
  type WiredNode,
} from "./graph-topology.js";

/** The native pairing brick's anchor input (injected — `PairStream.pushAnchor`).
 *  `payload` is OPAQUE to the brick (packed below, unpacked by the recorder). */
export interface PairAnchorSink {
  pushAnchor(anchor: {
    tExposure: bigint;
    stream: number;
    payload?: Float64Array;
  }): number;
}

/** The volts→angle + angle→H seams (a subset of the triple's conversions —
 *  the SAME `V2A`/`A2H` the display wrap + `conversionComputeH` consume). */
export type AnchorConversions = Pick<CoordinateConversions, "V2A" | "A2H">;

// --- root → downstream resolved-anchor key delivery (pairing-nodes ruling 2) --
// P-1 deferred "how downstream frames land identical keys"; R-1 resolves it with
// RESOLVED anchors (never re-stamping — that would violate trusted-time). The
// ROOT pairing brick tolerance-matches raw camera arrivals against the FIN
// anchor; the two matched frames' ACTUAL deviceTimestamps are the join keys the
// NEXT stage joins on (its convert/undistort output carries the same timestamps
// unchanged, meta-passthrough). The session reads the root's (FIN-rate, low)
// batched pair records and forwards each as a resolved anchor to the downstream
// `exact` brick — loop-safe, symmetric with the FIN-rate enrichment fan-out.

/** The subset of a native pair RECORD this forwarding needs (frame identity +
 *  provenance). Matches `Aravis.PairRecord` structurally. */
export interface PairRecordKeys {
  anchorId: number;
  tExposure: bigint;
  stream: number;
  payload: Float64Array;
  left: { deviceTimestamp: bigint };
  right: { deviceTimestamp: bigint };
}

/** The downstream `exact` brick's resolved-anchor input (injected —
 *  `PairStream.pushResolvedAnchor`). */
export interface PairResolvedAnchorSink {
  pushResolvedAnchor(anchor: {
    anchorId: number;
    tExposure: bigint;
    stream: number;
    leftKey: bigint;
    rightKey: bigint;
    payload?: Float64Array;
  }): number;
}

/** Map a ROOT pair record to the resolved-anchor push args for the NEXT stage:
 *  per-side keys are the matched frames' OWN deviceTimestamps (no re-stamping),
 *  origin `anchorId`/`tExposure`/`stream`/`payload` carried for provenance. */
export function resolvedAnchorFromRecord(
  rec: PairRecordKeys,
): Parameters<PairResolvedAnchorSink["pushResolvedAnchor"]>[0] {
  return {
    anchorId: rec.anchorId,
    tExposure: rec.tExposure,
    stream: rec.stream,
    leftKey: rec.left.deviceTimestamp,
    rightKey: rec.right.deviceTimestamp,
    payload: rec.payload,
  };
}

// --- opaque payload layout (doubles) ----------------------------------------
// Without conversions: [voltsL.x, voltsL.y, voltsR.x, voltsR.y] (length 4).
// With conversions: the above + [angL.x, angL.y, angR.x, angR.y] + H_L[9] +
// H_R[9] (length 26). The recorder unpacks via the offsets below.
export const ANCHOR_PAYLOAD = {
  VOLTS: 0, // 4 doubles (L.x, L.y, R.x, R.y)
  ANGLES: 4, // 4 doubles (L.x, L.y, R.x, R.y)
  H_LEFT: 8, // 9 doubles (3×3 row-major)
  H_RIGHT: 17, // 9 doubles
  LEN_VOLTS_ONLY: 4,
  LEN_FULL: 26,
} as const;

/** Pack a FIN outcome's enrichment attachments into the opaque anchor payload.
 *  `conv` absent → volts only (uncalibrated / deliberately-unwired v1 seam). */
export function packAnchorPayload(
  outcome: Pick<FrameOutcome, "left" | "right">,
  conv?: AnchorConversions,
): Float64Array {
  const vL: Pos = outcome.left;
  const vR: Pos = outcome.right;
  if (!conv) return new Float64Array([vL.x, vL.y, vR.x, vR.y]);
  const aL = conv.V2A.L(vL);
  const aR = conv.V2A.R(vR);
  const hL = conv.A2H.L(aL) as unknown as Float64Array; // Mat<Float64Array> IS one
  const hR = conv.A2H.R(aR) as unknown as Float64Array;
  const out = new Float64Array(ANCHOR_PAYLOAD.LEN_FULL);
  out[0] = vL.x;
  out[1] = vL.y;
  out[2] = vR.x;
  out[3] = vR.y;
  out[4] = aL.x;
  out[5] = aL.y;
  out[6] = aR.x;
  out[7] = aR.y;
  out.set(hL.subarray(0, 9), ANCHOR_PAYLOAD.H_LEFT);
  out.set(hR.subarray(0, 9), ANCHOR_PAYLOAD.H_RIGHT);
  return out;
}

/** The graph node id for the enrichment row (pairing-nodes ruling 7). */
export const anchorNodeId = (): string => `${nodeId.controller()}/anchors`;

/** Control-edge type (no frame on the FIN path — scalars). */
const FIN_STREAM = { kind: "analysis", schema: "pid" } as const;

export class AnchorNode {
  private readonly sinks = new Set<PairAnchorSink>();
  private conv: AnchorConversions | undefined;

  // Topology: `controller/anchors` fed by the controller's FIN outcomes.
  private readonly wiringNode: WiredNode = {
    id: anchorNodeId(),
    kind: "controller",
    output: null,
    transport: "native",
  };
  private readonly wiring: GraphWiring = {
    nodes: [this.wiringNode],
    edges: [
      { from: nodeId.controller(), to: anchorNodeId(), port: "fin", type: FIN_STREAM },
    ],
  };
  private readonly unregisterWiring: () => void;

  constructor(opts: { conversions?: AnchorConversions } = {}) {
    this.conv = opts.conversions;
    this.unregisterWiring = registerGraphWiring(this.wiring);
  }

  /** Install / replace / clear the volts→angle→H conversions (a triple binds
   *  them on activate; an uncalibrated rig leaves them absent → volts-only). */
  setConversions(conv: AnchorConversions | undefined): void {
    this.conv = conv;
  }

  /** Register a pairing brick as an anchor sink. N stage bricks share ONE
   *  enrichment source (the anchor is stage-independent). Returns an unregister. */
  register(sink: PairAnchorSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  get sinkCount(): number {
    return this.sinks.size;
  }

  /** Enrich ONE FIN outcome into an anchor and fan it out to every registered
   *  pairing brick. Trigger-mode only — the controller node forwards FIN
   *  outcomes here (pairing-nodes ruling 6). */
  ingest(outcome: FrameOutcome): void {
    const payload = packAnchorPayload(outcome, this.conv);
    for (const sink of this.sinks)
      sink.pushAnchor({
        tExposure: outcome.tExposure,
        stream: outcome.stream,
        payload,
      });
  }

  /** Retire the node (test/teardown): drop the graph row + sinks. */
  dispose(): void {
    this.sinks.clear();
    this.unregisterWiring();
  }
}

// --- module singleton (ONE anchor pool source, ruling 4) ---------------------
let singleton: AnchorNode | null = null;

export function anchorNode(): AnchorNode {
  if (!singleton) singleton = new AnchorNode();
  return singleton;
}

/** Test hook: dispose + clear the singleton between cases. */
export function resetAnchorNodeForTest(): void {
  singleton?.dispose();
  singleton = null;
}
