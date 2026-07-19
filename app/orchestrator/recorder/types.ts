// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared types for the MCAP recorder: the orchestrator-side writer facade, the
// channel→writer topology seam, and the main↔worker message protocol. Vue-free
// and core-free — `writer.ts`/the worker never touch `core`; all Mat/PixelFormat
// handling stays in `index.ts` (the sink layer), so the worker host code stays a
// pure bytes-in/bytes-out pipeline.

import { FOVEA_EXTENSION } from "./schema.js";

export { FOVEA_EXTENSION, TELEMETRY_TOPIC } from "./schema.js";

/**
 * Channel→writer mapping seam. Today exactly one implementation exists —
 * `singleFileTopology`, everything into one file — but the sink resolves every
 * stream through this interface, so full-res sharding (N writer workers / N
 * files per recording) becomes a new topology implementation, additive, with no
 * sink/worker API change.
 */
export interface RecorderTopology {
  /** Stable writer key hosting a given stream/channel name. */
  writerKeyFor(stream: string): string;
  /** File name (relative to the session directory) for a writer key. */
  fileNameFor(writerKey: string): string;
  /** Writer keys to eagerly create at session start (so the container file
   *  exists from t0 even if no frame ever arrives). */
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

/** Per-stream counters exposed to recording telemetry (`frames`/`dropped`/
 *  `bytes`, `fps`), plus the drop-cause split
 *  (`droppedQueue + droppedRing == dropped`). */
export interface StreamStats {
  frames: number;
  dropped: number;
  /** Drops caused by writer/encode backpressure (queue full). */
  droppedQueue: number;
  /** Drops caused by the ring lapping the read loop (source faster). */
  droppedRing: number;
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
  /** Finalize did NOT complete cleanly: the writer wedged past the deadline or
   *  the native finalize threw, so `abort()` left a crash-shape container on
   *  disk. Absent/false = a clean finalize. The recording service reads this to
   *  surface a banner and SKIP the viewer auto-open (a truncated container reads
   *  as a normal stop otherwise). */
  truncated?: boolean;
}

// ---- main-thread → worker protocol -------------------------------------

/**
 * Bench-only MCAP chunk-compression injection. Production NEVER sets this — the
 * recorder default is uncompressed, because compressing on the single
 * (non-reentrant) writer chain makes the throughput bottleneck worse. The worker
 * lazy-`require()`s `moduleEntry` ONLY when this field is present, so a
 * production build ships no compressor dependency.
 */
export interface CompressionInjection {
  /** MCAP chunk `compression` field written into the file (e.g. "lz4", "zstd"). */
  name: string;
  /** Absolute module path exporting the sync compressor (the bench resolves it
   *  from its own node_modules — never bundled into production). */
  moduleEntry: string;
  /** Named export to call as `(Buffer, level?) => Uint8Array`. */
  exportName: string;
  /** Optional second argument (e.g. zstd level); omitted for lz4. */
  level?: number;
}

export type RecorderWorkerIn =
  | {
      type: "init";
      filePath: string;
      /** McapWriter `chunkSize`. A chunk finalizes (and flushes to disk)
       *  after the first message that pushes it past this threshold, so any
       *  raw frame larger than this gets its own chunk — the "chunk ≈ 1 raw
       *  frame" crash-loss-window default. */
      chunkBytes: number;
      library: string;
      /** Session-level metadata record (ISO timestamp etc.). */
      session?: Record<string, string>;
      /** Bench-only chunk compression (see `CompressionInjection`). Undefined
       *  in production → uncompressed. */
      compression?: CompressionInjection;
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
       *  `end()`. */
      session?: Record<string, string>;
    };

// ---- worker → main-thread protocol --------------------------------------

export type RecorderWorkerOut =
  | { type: "written"; channel: string; bytes: number }
  | { type: "finalized"; id: number; stats: FinalizeStats }
  | { type: "error"; message: string; stack?: string };
