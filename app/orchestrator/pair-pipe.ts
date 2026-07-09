// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PAIRING brick seam (pairing-nodes P-1 / wave I-2). A core-free typed surface
// over `Aravis.createPairStream` — the per-stage L/R pairing brick (two
// in-process FIFO taps joined against FIN-derived anchors on the brick's own
// thread; record output via a batched async iterator, MultiKcf pattern).
//
// ALWAYS-RUNNING lifecycle (pairing-nodes ruling 5): a session creates its
// stage bricks with the trigger topology and releases them with it — the brick
// is NOT consumer-gated and keeps consuming (+ dropping) with zero subscribers.
// Trigger mode ONLY (ruling 1): anchors are real FIN outcomes; in free-run the
// pool is empty and the brick idles.
//
// Seam-injected (never imports native core) so the session and vitest drive a
// fake; index.ts wires the real `Aravis.createPairStream`.

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
