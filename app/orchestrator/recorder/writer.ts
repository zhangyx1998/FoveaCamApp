// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Main-thread host for one recorder worker (one McapWriter, one container
// file). Mirrors `stream-writer.ts`'s architecture — worker_threads worker
// fed by transferred ArrayBuffers, bounded queue, fail-fast on worker error
// — but multiplexes N channels into a single file and is metered from day
// one (docs/refactor/workload-metering.md; the `recorder:<name>` family
// `stream-writer.ts` started, extended here to one workload per container
// file with per-channel ingest counters).
//
// Backpressure contract (recorder-container.md §3): the orchestrator loop
// must never block on the recorder. `writeFrame` is synchronous and never
// awaits — when a channel's in-flight window is full the frame is REFUSED
// (returns false) and accounted as a drop; the payload thunk is not even
// invoked, so no copy is wasted on a frame that won't ship. Drops are data,
// not silent: they land in the workload meter (`byReason` backpressure/
// failed) and in the caller's per-stream stats.
//
// This class is deliberately core-free (bytes in, bytes out) — Mat/
// PixelFormat handling lives in the sink layer (`index.ts`).

import { Worker, type TransferListItem } from "node:worker_threads";
import { createRequire } from "node:module";
import { registerWorkload, type WorkloadHandle } from "../metering.js";
import { WORKER_SOURCE } from "./worker-source.js";
import {
  TELEMETRY_TOPIC,
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
}

export class McapWriterWorker {
  /** Any message larger than this finalizes (flushes) its chunk — every raw
   *  camera frame (≥ ~1.5 MiB) gets chunk ≈ 1 frame, the B-4 crash-loss
   *  default, while tiny telemetry messages coalesce into the next frame's
   *  chunk instead of bloating the chunk index. */
  static readonly chunkBytes = 256 * 1024;
  static readonly maxQueuedFrames = 8;

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
    });
    // The telemetry/metadata channel exists on every container — registered
    // up front so per-frame extras can ride along from the first frame.
    this.registerChannel(TELEMETRY_TOPIC, {
      schema: "fovea.frame_meta/v1",
      schemaData: JSON.stringify({
        description:
          "Per-frame JSON metadata document: {stream, seq, t, ...extras} — " +
          "extras are the legacy .meta sidecar's `x` payload (volt/angle/affine). " +
          "Correlate with the frame by stream+seq (or logTime).",
      }),
      messageEncoding: "json",
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
