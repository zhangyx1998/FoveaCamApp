// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared types for the MCAP recorder (docs/refactor/recorder-container.md
// §2 decision + §3): the orchestrator-side writer facade, the channel→writer
// topology seam, and the main↔worker message protocol. Vue-free and
// core-free — `writer.ts`/the worker never touch `core`; all Mat/PixelFormat
// handling stays in `index.ts` (the sink layer), so the worker host code
// stays a pure bytes-in/bytes-out pipeline like `stream-writer.ts`'s worker.

/** Topic name of the single telemetry/metadata channel every recording
 *  carries — per-frame JSON documents (volt/angle/homography extras, plus
 *  seq/t/stream for correlation), the stuff the legacy `.meta` sidecar
 *  carried per line. */
export const TELEMETRY_TOPIC = "telemetry";

/** On-disk extension for the new single-file container. The content is
 *  standard MCAP — the extension is a planner proposal (user may veto);
 *  generic `mcap` CLI / Python tooling reads these files as-is. */
export const FOVEA_EXTENSION = ".fovea";

/**
 * Channel→writer mapping seam (recorder-container.md §2 follow-up 1).
 * Today exactly one implementation exists — `singleFileTopology`, everything
 * into one file — but the sink resolves every stream through this interface,
 * so full-res sharding (N writer workers / N files per recording) becomes a
 * new topology implementation, additive, with no sink/worker API change.
 * Deliberately NOT implemented this round — user decision pending.
 */
export interface RecorderTopology {
  /** Stable writer key hosting a given stream/channel name. */
  writerKeyFor(stream: string): string;
  /** File name (relative to the session directory) for a writer key. */
  fileNameFor(writerKey: string): string;
  /** Writer keys to eagerly create at session start (so the container file
   *  exists from t0 even if no frame ever arrives — the legacy writer's
   *  manifest-at-start behavior, ported). */
  initialWriterKeys(): readonly string[];
}

/** The default (and currently only) topology: every channel into one writer,
 *  one `<baseName>.fovea` file per recording session. */
export function singleFileTopology(baseName: string): RecorderTopology {
  return {
    writerKeyFor: () => "main",
    fileNameFor: () => `${baseName}${FOVEA_EXTENSION}`,
    initialWriterKeys: () => ["main"],
  };
}

/** Per-stream counters exposed to recording telemetry — same shape the
 *  legacy path derived from `StreamWriter` (`frames`/`dropped`/`bytes` from
 *  `summary`, `fps` from its `FreqMeter`). */
export interface StreamStats {
  frames: number;
  dropped: number;
  bytes: number;
  fps: number;
}

/** Aggregate result the worker reports back from `finalize` — after
 *  `McapWriter.end()` has written the summary/index sections. */
export interface FinalizeStats {
  /** Total MCAP messages written (bigint stringified — crosses postMessage). */
  messageCount: string;
  chunkCount: number;
  /** Bytes written to the container file. */
  bytes: number;
}

// ---- main-thread → worker protocol -------------------------------------

export type RecorderWorkerIn =
  | {
      type: "init";
      filePath: string;
      /** McapWriter `chunkSize`. A chunk finalizes (and flushes to disk)
       *  after the first message that pushes it past this threshold, so any
       *  raw frame larger than this gets its own chunk — the "chunk ≈ 1 raw
       *  frame" crash-loss-window default from the B-4 bench. */
      chunkBytes: number;
      library: string;
      /** Session-level metadata record (ISO timestamp etc.). */
      session?: Record<string, string>;
    }
  | {
      type: "channel";
      name: string;
      schema: string;
      schemaData: string;
      messageEncoding: string;
      metadata: Record<string, string>;
    }
  | {
      type: "frame";
      channel: string;
      seq: number;
      logTimeNs: bigint;
      data: ArrayBuffer;
    }
  | {
      /** Per-frame telemetry document riding the frame's queue slot — sent
       *  (immediately before its frame) only when the frame carries extras,
       *  so it shares the frame's backpressure fate and needs no ack. */
      type: "meta";
      channel: string;
      seq: number;
      logTimeNs: bigint;
      payload: string;
    }
  | {
      type: "finalize";
      id: number;
      /** Optional closing metadata record (e.g. durationSec) written before
       *  `end()` — the new home of the legacy manifest's `duration`. */
      session?: Record<string, string>;
    };

// ---- worker → main-thread protocol --------------------------------------

export type RecorderWorkerOut =
  | { type: "written"; channel: string; bytes: number }
  | { type: "finalized"; id: number; stats: FinalizeStats }
  | { type: "error"; message: string; stack?: string };
