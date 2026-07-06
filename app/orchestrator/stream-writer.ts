// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Server-side stream writer. The public API and on-disk format match the old
// renderer writer (`.stream` binary + `.meta` JSONL sidecar), but disk I/O now
// runs in a worker_threads worker so recording backpressure does not stall the
// orchestrator event loop. The worker intentionally imports no `core` modules;
// the orchestrator thread computes metadata and transfers plain ArrayBuffers.

import { Worker, type TransferListItem } from "node:worker_threads";
import type { Mat } from "core/Vision";
import type { PixelFormat } from "core/Aravis";
import { FreqMeter } from "@lib/util/rolling";
import { dtypeOf, significantBits, type Dtype } from "@lib/util/dtype";
import { registerWorkload, type WorkloadHandle } from "./metering.js";

export type CompressionFormat = "lz4" | "zstd";

export interface FrameMeta<X extends Extensions = Extensions> {
  /** offset */
  o: number;
  /** length in bytes (maybe compressed) */
  n: number;
  /** compresion type, raw if omitted */
  c?: CompressionFormat;
  /** shape of the frame data */
  s: number[];
  /** dtype */
  d: Dtype;
  /** timestamp in seconds, floating point */
  t: number;
  /** pixel format */
  f: PixelFormat;
  /** significant bit depth (e.g. 12 for 12p data stored in a 16-bit container) */
  b: number;
  /** extra metadata */
  x?: X;
}

interface AffineExtension {
  /** 3x3 homography matrix in row-major order */
  affine: number[];
}

type Extensions = Partial<AffineExtension>;

type WorkerIn =
  | {
      type: "init";
      basePath: string;
      name: string;
      highWaterMark: number;
    }
  | { type: "frame"; data: ArrayBuffer; entry: FrameMeta }
  | { type: "flush"; id: number };

type WorkerOut =
  | { type: "written" }
  | { type: "flushed"; id: number }
  | { type: "error"; message: string; stack?: string };

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { createWriteStream } = require("node:fs");
const { resolve } = require("node:path");

let stream = null;
let meta = null;
let chain = Promise.resolve();
let closed = false;

function writeChunk(ws, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      ws.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      ws.off("error", onError);
      resolve();
    };
    ws.once("error", onError);
    if (ws.write(chunk)) onDrain();
    else ws.once("drain", onDrain);
  });
}

function endStream(ws) {
  return new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.end(resolve);
  });
}

async function writeFrame(message) {
  if (!stream || !meta || closed) throw new Error("StreamWriter worker is not open");
  const buf = Buffer.from(message.data);
  await Promise.all([
    writeChunk(stream, buf),
    writeChunk(meta, JSON.stringify(message.entry) + "\n"),
  ]);
}

async function flush() {
  if (closed) return;
  closed = true;
  await Promise.all([endStream(meta), endStream(stream)]);
}

function report(error) {
  parentPort.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

parentPort.on("message", (message) => {
  if (message.type === "init") {
    const metaPath = resolve(message.basePath, message.name + ".meta");
    const streamPath = resolve(message.basePath, message.name + ".stream");
    meta = createWriteStream(metaPath, { encoding: "utf8" });
    stream = createWriteStream(streamPath, { highWaterMark: message.highWaterMark });
    return;
  }

  if (message.type === "frame") {
    chain = chain.then(() => writeFrame(message)).then(
      () => parentPort.postMessage({ type: "written" }),
      (error) => report(error),
    );
    return;
  }

  if (message.type === "flush") {
    chain = chain.then(() => flush()).then(
      () => parentPort.postMessage({ type: "flushed", id: message.id }),
      (error) => report(error),
    );
  }
});
`;

export default class StreamWriter {
  static readonly highWaterMark = 256 * 1024 * 1024;
  static readonly maxQueuedFrames = 8;
  private readonly worker: Worker;
  private readonly maxQueuedFrames: number;
  readonly fps = new FreqMeter();
  frameCount = 0;
  dropped = 0;
  private byteOffset = 0;
  private queued = 0;
  private flushSeq = 0;
  private flushing = false;
  private failed: Error | null = null;
  private readonly flushes = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  // Perf substrate (docs/refactor/workload-metering.md, "recorder worker" —
  // flagship first citizen): meters the main-thread side of the handoff
  // (frame prep + post, drops); the worker_threads worker itself is a
  // separate thread with no metering hook of its own this round.
  private readonly workload: WorkloadHandle;

  constructor(
    basePath: string,
    private readonly name: string,
    options: { maxQueuedFrames?: number } = {},
  ) {
    this.maxQueuedFrames =
      options.maxQueuedFrames ?? StreamWriter.maxQueuedFrames;
    this.workload = registerWorkload(`recorder:${name}`, {
      inputs: ["frame"],
      outputs: ["written"],
    });
    this.worker = new Worker(WORKER_SOURCE, { eval: true });
    this.worker.on("message", (message: WorkerOut) =>
      this.handleWorkerMessage(message),
    );
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.flushing && code !== 0)
        this.fail(new Error(`StreamWriter worker exited with code ${code}`));
    });
    this.post({
      type: "init",
      basePath,
      name,
      highWaterMark: StreamWriter.highWaterMark,
    });
  }

  private fail(error: Error): void {
    if (!this.failed) this.failed = error;
    for (const { reject } of this.flushes.values()) reject(error);
    this.flushes.clear();
    this.workload.dispose();
  }

  private handleWorkerMessage(message: WorkerOut): void {
    if (message.type === "written") {
      this.queued = Math.max(0, this.queued - 1);
      this.workload.emit("written");
      return;
    }
    if (message.type === "flushed") {
      const flush = this.flushes.get(message.id);
      this.flushes.delete(message.id);
      flush?.resolve();
      return;
    }
    this.fail(Object.assign(new Error(message.message), { stack: message.stack }));
  }

  private post(message: WorkerIn, transfer?: TransferListItem[]): void {
    this.worker.postMessage(message, transfer ?? []);
  }

  write(
    frame: Mat,
    format: PixelFormat,
    timestamp = performance.now() / 1000,
    extra?: Record<string, unknown>,
  ) {
    if (this.failed || this.queued >= this.maxQueuedFrames) {
      this.dropped++;
      this.workload.drop(this.failed ? "failed" : "backpressure");
      return;
    }
    this.workload.ingest("frame");
    this.workload.begin();
    const data = new ArrayBuffer(frame.byteLength);
    new Uint8Array(data).set(
      new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
    );
    const entry: FrameMeta = {
      o: this.byteOffset,
      n: data.byteLength,
      d: dtypeOf(frame),
      s: [...frame.shape],
      t: timestamp,
      f: format,
      b: significantBits(format),
      x: extra,
    };
    this.byteOffset += data.byteLength;
    this.frameCount++;
    this.fps.tick();
    this.queued++;
    this.post({ type: "frame", data, entry }, [data]);
    this.workload.end();
  }

  flush(): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.flushSeq;
    return new Promise<void>((resolve, reject) => {
      this.flushes.set(id, { resolve, reject });
      this.post({ type: "flush", id });
    }).then(async () => {
      this.flushing = true;
      await this.worker.terminate();
      this.workload.dispose();
    });
  }

  get summary() {
    return {
      frames: this.frameCount,
      dropped: this.dropped,
      bytes: this.byteOffset,
    };
  }
}
