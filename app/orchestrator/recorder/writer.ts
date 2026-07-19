// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Main-thread host for one recorder worker (one McapWriter, one container file): a
// worker fed by transferred ArrayBuffers, bounded queue, fail-fast, N channels into
// one file, metered. Core-free (bytes in, bytes out). Load-bearing backpressure
// contract: writeFrame is synchronous and REFUSES (returns false, accounts a drop, no
// wasted copy) when a channel's in-flight window is full — the orchestrator loop must
// never block on the recorder.
// spec: docs/spec/capture-recording.md#recorder-writer

import { Worker, type TransferListItem } from "node:worker_threads";
import { createRequire } from "node:module";
import { registerWorkload, type WorkloadHandle } from "../metering.js";
import { WORKER_SOURCE } from "./worker-source.js";
import {
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_QUEUED_FRAMES,
  TELEMETRY_MESSAGE_ENCODING,
  TELEMETRY_SCHEMA_DATA,
  TELEMETRY_SCHEMA_NAME,
  TELEMETRY_TOPIC,
} from "./schema.js";
import {
  type CompressionInjection,
  type FinalizeStats,
  type RecorderWorkerIn,
  type RecorderWorkerOut,
} from "./types.js";

// Resolved against THIS module's location (works from the vite-bundled
// orchestrator in .dist/electron, from vitest, and from a packaged asar —
// node_modules sits up-tree in all three), NOT against process.cwd() like a
// bare require() inside an eval worker would.
const requireFromHere = createRequire(import.meta.url);

export interface McapWriterWorkerOptions {
  /** McapWriter chunk threshold — see `types.ts` (chunk ≈ 1 raw frame). */
  chunkBytes?: number;
  /** Per-channel in-flight frame window before refusing (drop). */
  maxQueuedFrames?: number;
  /** Session-level metadata record written at start. */
  session?: Record<string, string>;
  /** Bench-only: inject MCAP chunk compression. NEVER set by production callers
   *  — the recorder default is uncompressed. */
  compression?: CompressionInjection;
}

export class McapWriterWorker {
  /** Any message larger than this finalizes (flushes) its chunk — every raw
   *  camera frame (≥ ~1.5 MiB) gets chunk ≈ 1 frame, the crash-loss default,
   *  while tiny telemetry messages coalesce into the next frame's chunk instead
   *  of bloating the chunk index. */
  static readonly chunkBytes = DEFAULT_CHUNK_BYTES;
  static readonly maxQueuedFrames = DEFAULT_MAX_QUEUED_FRAMES;

  private readonly worker: Worker;
  private readonly maxQueuedFrames: number;
  private readonly queued = new Map<string, number>();
  private failed: Error | null = null;
  private finalizing = false;
  private pendingFinalize: {
    resolve: (stats: FinalizeStats) => void;
    reject: (error: Error) => void;
  } | null = null;
  private readonly workload: WorkloadHandle;

  constructor(
    readonly filePath: string,
    readonly name: string,
    options: McapWriterWorkerOptions = {},
  ) {
    this.maxQueuedFrames = options.maxQueuedFrames ?? McapWriterWorker.maxQueuedFrames;
    this.workload = registerWorkload(`recorder:${name}`, {
      inputs: [],
      outputs: ["written", "bytes"],
    });
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { mcapEntry: requireFromHere.resolve("@mcap/core") },
    });
    this.worker.on("message", (message: RecorderWorkerOut) => this.handleMessage(message));
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.finalizing && code !== 0)
        this.fail(new Error(`recorder worker exited with code ${code}`));
    });
    this.post({
      type: "init",
      filePath,
      chunkBytes: options.chunkBytes ?? McapWriterWorker.chunkBytes,
      library: "FoveaCamApp",
      session: options.session,
      compression: options.compression,
    });
    // The telemetry/metadata channel exists on every container — registered
    // up front so per-frame extras can ride along from the first frame.
    this.registerChannel(TELEMETRY_TOPIC, {
      schema: TELEMETRY_SCHEMA_NAME,
      schemaData: TELEMETRY_SCHEMA_DATA,
      messageEncoding: TELEMETRY_MESSAGE_ENCODING,
      metadata: {},
    });
  }

  get error(): Error | null {
    return this.failed;
  }

  private fail(error: Error): void {
    if (!this.failed) this.failed = error;
    this.pendingFinalize?.reject(error);
    this.pendingFinalize = null;
    this.workload.dispose();
  }

  private handleMessage(message: RecorderWorkerOut): void {
    if (message.type === "written") {
      this.queued.set(message.channel, Math.max(0, (this.queued.get(message.channel) ?? 0) - 1));
      this.workload.emit("written");
      this.workload.emit("bytes", message.bytes);
      return;
    }
    if (message.type === "finalized") {
      this.pendingFinalize?.resolve(message.stats);
      this.pendingFinalize = null;
      return;
    }
    this.fail(Object.assign(new Error(message.message), { stack: message.stack }));
  }

  private post(message: RecorderWorkerIn, transfer?: TransferListItem[]): void {
    this.worker.postMessage(message, transfer ?? []);
  }

  /** Register a frame channel. Must be posted before that channel's first
   *  frame — port ordering guarantees the worker processes it first. */
  registerChannel(
    name: string,
    spec: {
      schema: string;
      schemaData: string;
      messageEncoding: string;
      metadata: Record<string, string>;
    },
  ): void {
    if (this.failed) return;
    this.post({ type: "channel", name, ...spec });
  }

  /**
   * Enqueue one frame (plus its optional telemetry document, which rides the
   * same queue slot and shares its fate). Synchronous; never blocks. Returns
   * false — WITHOUT invoking `produce` — when the frame is refused (failed
   * writer, or the channel's in-flight window is full).
   */
  writeFrame(
    channel: string,
    seq: number,
    logTimeNs: bigint,
    produce: () => ArrayBuffer,
    metaPayload?: string,
  ): boolean {
    if (this.failed) {
      this.workload.drop("failed");
      return false;
    }
    const inFlight = this.queued.get(channel) ?? 0;
    if (inFlight >= this.maxQueuedFrames) {
      this.workload.drop("backpressure");
      return false;
    }
    this.workload.ingest(channel);
    this.workload.begin();
    const data = produce();
    if (metaPayload !== undefined) {
      this.post({ type: "meta", channel: TELEMETRY_TOPIC, seq, logTimeNs, payload: metaPayload });
    }
    this.queued.set(channel, inFlight + 1);
    this.post({ type: "frame", channel, seq, logTimeNs, data }, [data]);
    this.workload.end();
    return true;
  }

  /** Depth of a channel's in-flight window (mostly for tests/metrics). */
  queueDepth(channel: string): number {
    return this.queued.get(channel) ?? 0;
  }

  /** Stop recording WITHOUT finalizing: terminate the worker immediately, so
   *  the chunk still buffered in the writer is lost and the file has no
   *  footer/summary — a crash-shaped container that only the streaming/
   *  re-index reader path recovers. Used to cancel a recording and by the
   *  recorder bench's crash test. Idempotent. */
  async abort(): Promise<void> {
    this.finalizing = true; // suppress the exit→fail path on abrupt terminate
    this.pendingFinalize = null;
    await this.worker.terminate();
    this.workload.dispose();
  }

  /** Drain the write chain, write the MCAP summary/index sections, close the
   *  file, and terminate the worker. Rejects if the writer already failed. */
  finalize(session?: Record<string, string>): Promise<FinalizeStats> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.pendingFinalize) return Promise.reject(new Error("finalize already in progress"));
    return new Promise<FinalizeStats>((resolve, reject) => {
      this.pendingFinalize = { resolve, reject };
      this.post({ type: "finalize", id: 1, session });
    }).then(async (stats) => {
      this.finalizing = true;
      await this.worker.terminate();
      this.workload.dispose();
      return stats;
    });
  }
}
