// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Crash-mid-write recoverability test. Runs a short write session through
// the same writer-worker used by bench.ts, then SIGKILLs the worker's OS
// thread by terminating the worker abruptly (never sending "stop", so
// McapWriter.end() never runs and no footer/summary section is written) -
// simulating an orchestrator process crash mid-recording. Then attempts to
// open the resulting file two ways:
//   1. McapIndexedReader (requires footer) - expected to fail; confirms the
//      index-based path is NOT crash-tolerant on its own.
//   2. McapStreamReader (sequential, no footer needed) - reads whatever
//      complete records exist up to the truncation point.
//
// Usage: /opt/homebrew/bin/node src/crash-recovery.ts --size=1.5 --compression=none

import { Worker } from "node:worker_threads";
import { mkdir, stat, rm, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { McapIndexedReader, McapStreamReader } from "@mcap/core";
import { FileHandleReadable } from "@mcap/nodejs";
import { uncompressSync as lz4Uncompress } from "lz4-napi";
import { decompress as zstdDecompress } from "zstd-napi";
import {
  RAW_FRAME_MESSAGE_ENCODING,
  RAW_FRAME_SCHEMA_NAME,
} from "../../../docs/schema/fovea.ts";
import { buildFramePool, buildProcessedPool } from "./synth.ts";
import type { WorkerIn, WorkerOut, Compression, ChannelSpec } from "./protocol.ts";

function parseArgs() {
  const map = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) map.set(m[1]!, m[2]!);
  }
  return {
    size: Number(map.get("size") ?? "1.5"),
    compression: (map.get("compression") ?? "none") as Compression,
    runMs: Number(map.get("runMs") ?? "4000"),
    out: map.get("out") ?? "./out",
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  await mkdir(args.out, { recursive: true });
  const filePath = `${args.out}/crash-${args.size}MiB-${args.compression}.mcap`;
  await rm(filePath, { force: true });

  const rawTargetBytes = Math.round(args.size * 1024 * 1024);
  const rawPool = buildFramePool(rawTargetBytes);
  const procPool = buildProcessedPool(Math.max(65536, Math.round(rawTargetBytes / 8)));

  const channels: { spec: ChannelSpec; fps: number; pool: readonly Uint8Array[] }[] = [
    ...["cam0", "cam1", "cam2"].map((name) => ({
      spec: {
        topic: `raw/${name}`,
        schemaName: RAW_FRAME_SCHEMA_NAME,
        messageEncoding: RAW_FRAME_MESSAGE_ENCODING,
        metadata: {
          dtype: "U8",
          shape: JSON.stringify([rawPool.height, rawPool.width]),
          channels: "1",
          pixelFormat: "BayerRG12p",
          significantBits: "12",
        },
      },
      fps: 60,
      pool: rawPool.frames,
    })),
    {
      spec: {
        topic: "processed/disparity",
        schemaName: RAW_FRAME_SCHEMA_NAME,
        messageEncoding: RAW_FRAME_MESSAGE_ENCODING,
        metadata: {
          dtype: "U8",
          shape: JSON.stringify([procPool.height, procPool.width]),
          channels: "1",
          pixelFormat: "Mono8",
          significantBits: "8",
        },
      },
      fps: 30,
      pool: procPool.frames,
    },
  ];

  const worker = new Worker(new URL("./writer-worker.ts", import.meta.url));
  let written = 0;
  let bytesWritten = 0;
  let ready = false;
  worker.on("message", (msg: WorkerOut) => {
    if (msg.type === "ready") ready = true;
    if (msg.type === "ack") written++;
  });
  worker.postMessage({
    type: "init",
    filePath,
    chunkSize: Math.round(rawTargetBytes * 1.05),
    compression: args.compression,
    zstdLevel: 1,
    channels: channels.map((c) => c.spec),
  } satisfies WorkerIn);
  while (!ready) await sleep(5);

  let seq = 0;
  const start = performance.now();
  let stop = false;
  function produce(ch: (typeof channels)[number], idx: number): void {
    if (stop) return;
    const template = ch.pool[idx % ch.pool.length]!;
    const data = new ArrayBuffer(template.byteLength);
    new Uint8Array(data).set(template);
    bytesWritten += data.byteLength;
    worker.postMessage(
      {
        type: "frame",
        topic: ch.spec.topic,
        seq: seq++,
        logTimeNs: BigInt(Math.round(performance.now() * 1e6)),
        data,
      } satisfies WorkerIn,
      [data],
    );
    const period = 1000 / ch.fps;
    const nextDue = start + (idx + 1) * period;
    setTimeout(() => produce(ch, idx + 1), Math.max(0, nextDue - performance.now()));
  }
  channels.forEach((ch) => produce(ch, 0));

  await sleep(args.runMs);
  stop = true;
  // Simulate a hard crash: terminate the worker WITHOUT sending "stop", so
  // McapWriter.end() (footer/summary/index write) never executes and
  // whatever chunk is currently buffered in memory (never flushed to disk)
  // is lost, exactly like a process getting SIGKILLed mid-recording.
  await sleep(50); // let in-flight postMessage frames actually reach the worker's queue
  await worker.terminate();

  const fileBytes = (await stat(filePath).catch(() => undefined))?.size ?? 0;
  console.log(
    `[crash-recovery] size=${args.size}MiB compression=${args.compression} ` +
      `frames-sent=${seq} frames-acked=${written} bytesAttempted=${bytesWritten} fileBytesOnDisk=${fileBytes}`,
  );

  // 1) Indexed reader - expect failure (no footer).
  let indexedOk = false;
  let indexedError = "";
  try {
    const handle = await open(filePath, "r");
    await McapIndexedReader.Initialize({ readable: new FileHandleReadable(handle) });
    indexedOk = true;
    await handle.close();
  } catch (error) {
    indexedError = error instanceof Error ? error.message : String(error);
  }

  // 2) Streaming reader - read whatever complete records exist.
  const reader = new McapStreamReader({
    validateCrcs: true,
    decompressHandlers: {
      lz4: (data) => lz4Uncompress(Buffer.from(data)),
      zstd: (data) => zstdDecompress(Buffer.from(data)) as Uint8Array,
    },
  });
  let recoveredMessages = 0;
  let recoveredBytes = 0;
  let streamError = "";
  await new Promise<void>((resolve) => {
    const rs = createReadStream(filePath);
    rs.on("data", (chunk: Buffer) => {
      reader.append(chunk);
      try {
        for (let record; (record = reader.nextRecord()); ) {
          if (record.type === "Message") {
            recoveredMessages++;
            recoveredBytes += record.data.byteLength;
          }
        }
      } catch (error) {
        streamError = error instanceof Error ? error.message : String(error);
        rs.close();
        resolve();
      }
    });
    rs.on("end", () => resolve());
    rs.on("error", (error) => {
      streamError = error.message;
      resolve();
    });
  });

  const summary = {
    size: args.size,
    compression: args.compression,
    framesSentToWorker: seq,
    framesAckedByWorker: written,
    fileBytesOnDisk: fileBytes,
    indexedReaderOpensAfterCrash: indexedOk,
    indexedReaderError: indexedError || undefined,
    streamReaderRecoveredMessages: recoveredMessages,
    streamReaderRecoveredBytes: recoveredBytes,
    streamReaderDone: reader.done(),
    streamReaderBytesRemainingUnparsed: reader.bytesRemaining(),
    streamReaderError: streamError || undefined,
  };
  console.log("RESULT_CRASH:" + JSON.stringify(summary));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
