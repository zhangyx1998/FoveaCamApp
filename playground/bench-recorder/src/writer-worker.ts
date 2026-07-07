// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// worker_threads worker hosting a single McapWriter multiplexing all channels
// into one file. Imports no `core`/Vue - mirrors stream-writer.ts's isolation
// (the real recorder worker must stay hardware/UI-free too). Every method
// call into McapWriter is serialized through a promise chain, exactly like
// stream-writer.ts's `chain = chain.then(...)` pattern, because the MCAP
// writer is documented as non-reentrant ("wait on any method call to
// complete before calling another").

import { parentPort } from "node:worker_threads";
import { open } from "node:fs/promises";
import { McapWriter } from "@mcap/core";
import { FileHandleWritable } from "@mcap/nodejs";
import { compressSync as lz4CompressSync } from "lz4-napi";
import { compress as zstdCompressSync } from "zstd-napi";
import type { WorkerIn, WorkerOut, Compression } from "./protocol.ts";

if (!parentPort) throw new Error("writer-worker must run as a worker_thread");
const port = parentPort;

function post(message: WorkerOut): void {
  port.postMessage(message);
}

function pickCompressor(
  compression: Compression,
  zstdLevel: number,
): ((chunkData: Uint8Array) => { compression: string; compressedData: Uint8Array }) | undefined {
  if (compression === "none") return undefined;
  if (compression === "lz4") {
    return (chunkData) => ({
      compression: "lz4",
      compressedData: lz4CompressSync(Buffer.from(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength)),
    });
  }
  return (chunkData) => ({
    compression: "zstd",
    compressedData: zstdCompressSync(
      Buffer.from(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength),
      zstdLevel,
    ),
  });
}

let writer: McapWriter | undefined;
const channelIds = new Map<string, number>();
let chain: Promise<void> = Promise.resolve();
let written = 0;
let bytesWritten = 0;
const encoder = new TextEncoder();
/** Baseline for authoritative whole-run worker CPU accounting (see "stopped"). */
const cpuBaseline = process.cpuUsage();

async function init(msg: Extract<WorkerIn, { type: "init" }>): Promise<void> {
  const handle = await open(msg.filePath, "w");
  const writable = new FileHandleWritable(handle);
  writer = new McapWriter({
    writable,
    useChunks: true,
    chunkSize: msg.chunkSize,
    compressChunk: pickCompressor(msg.compression, msg.zstdLevel ?? 1),
    useMessageIndex: true,
    useChunkIndex: true,
    useStatistics: true,
    useSummaryOffsets: true,
  });
  await writer.start({ profile: "fovea-bench", library: "bench-recorder" });
  for (const ch of msg.channels) {
    const schemaId = await writer.registerSchema({
      name: ch.schemaName,
      encoding: "jsonschema",
      data: encoder.encode(JSON.stringify({ topic: ch.topic, ...ch.metadata })),
    });
    const channelId = await writer.registerChannel({
      schemaId,
      topic: ch.topic,
      messageEncoding: ch.messageEncoding,
      metadata: new Map(Object.entries(ch.metadata)),
    });
    channelIds.set(ch.topic, channelId);
  }
  post({ type: "ready" });
}

function onFrame(msg: Extract<WorkerIn, { type: "frame" }>): void {
  chain = chain
    .then(async () => {
      if (!writer) throw new Error("writer not initialized");
      const channelId = channelIds.get(msg.topic);
      if (channelId == undefined) throw new Error(`unknown topic ${msg.topic}`);
      const data = new Uint8Array(msg.data);
      await writer.addMessage({
        channelId,
        sequence: msg.seq,
        logTime: msg.logTimeNs,
        publishTime: msg.logTimeNs,
        data,
      });
      written++;
      bytesWritten += data.byteLength;
      post({ type: "ack", topic: msg.topic });
    })
    .catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      post({ type: "error", message: err.message, stack: err.stack });
    });
}

function metrics(): void {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  post({
    type: "metrics",
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    cpuUserUs: cpu.user,
    cpuSystemUs: cpu.system,
    written,
    bytesWritten,
  });
}

async function stop(): Promise<void> {
  chain = chain.then(async () => {
    if (!writer) return;
    await writer.end();
    const stats = writer.statistics;
    const cpu = process.cpuUsage(cpuBaseline);
    post({
      type: "stopped",
      written,
      bytesWritten,
      fileBytes: 0, // caller stats the file directly after the worker exits
      chunkCount: stats?.chunkCount ?? 0,
      messageCount: String(stats?.messageCount ?? 0n),
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
    });
  });
  await chain;
}

port.on("message", (msg: WorkerIn) => {
  if (msg.type === "init") {
    init(msg).catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      post({ type: "error", message: err.message, stack: err.stack });
    });
    return;
  }
  if (msg.type === "frame") {
    onFrame(msg);
    return;
  }
  if (msg.type === "metrics-request") {
    metrics();
    return;
  }
  if (msg.type === "stop") {
    stop().catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      post({ type: "error", message: err.message, stack: err.stack });
    });
  }
});
