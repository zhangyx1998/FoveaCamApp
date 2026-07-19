// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pairing brick seam: a core-free typed surface over Aravis.createPairStream — the
// per-stage L/R pairing brick (two in-process FIFO taps joined against FIN-derived
// anchors on the brick's own thread; batched async-iterator record output). Always-
// running (NOT consumer-gated), trigger mode only (free-run idles with an empty
// anchor pool). Seam-injected (never imports core).
// spec: docs/spec/pipes.md#pair-pipe

import type { WorkloadSnapshot } from "@lib/orchestrator/stats.js";
import type {
  PairAnchorSink,
  PairResolvedAnchorSink,
  PairRecordKeys,
} from "./anchor-node.js";

/** One matched frame's identity inside a pair record (structural subset of
 *  `Aravis.PairFrameId` — the carried deviceTimestamp IS the downstream join
 *  key, trusted-time). */
export interface PairFrameKeys {
  deviceTimestamp: bigint;
}

/** One completed pair record (structural match of `Aravis.PairRecord`;
 *  extends the anchor-node's key subset so `resolvedAnchorFromRecord` accepts
 *  it directly). `payload` echoes the enrichment node's opaque doubles. */
export interface PairRecord extends PairRecordKeys {
  left: PairFrameKeys;
  right: PairFrameKeys;
}

export interface PairBatch {
  records: PairRecord[];
}

/** Construction options (structural subset of `Aravis.PairStreamOptions`). */
export interface PairPipeOptions {
  /** `root` tolerance-matches raw arrivals against FIN anchors; `exact` joins
   *  on identical carried deviceTimestamps with a RESOLVED anchor. */
  mode?: "root" | "exact";
  /** Graph node id (`pair/<stage>`). */
  stage?: string;
  /** The anchor edge's source row (`controller/anchors` for the root; the
   *  root's stage id for a downstream exact brick). */
  anchorFrom?: string;
  toleranceNs?: bigint;
}

/** The brick handle the session drives — anchor sinks (the anchor-node
 *  register surface + the root→downstream resolved delivery), the batched
 *  record iterator, the standard probe, and release. */
export interface PairHandle
  extends AsyncIterable<PairBatch>,
    PairAnchorSink,
    PairResolvedAnchorSink {
  readonly id: string;
  probe(): WorkloadSnapshot;
  /** Drop the brick (join its thread; closes the iterator). Idempotent. */
  release(): void;
}

/** Create one per-stage pairing brick over two LIVE source brick ids (convert /
 *  undistort). Throws when a source is missing — callers wire a stage only when
 *  its bricks are live. Production: `Aravis.createPairStream`. */
export type PairPipeSeam = (
  leftId: string,
  rightId: string,
  options?: PairPipeOptions,
) => PairHandle;
