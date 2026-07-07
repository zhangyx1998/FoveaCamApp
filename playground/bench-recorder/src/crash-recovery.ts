// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Crash-mid-write recoverability test — B-P4: now drives the PRODUCTION
// recorder writer (app/orchestrator/recorder/writer.ts). Runs a short write
// session through McapWriterWorker, then calls its `abort()` (terminate the
// worker WITHOUT finalize, so McapWriter.end() never runs and the chunk still
// buffered in memory is lost) — exactly the orchestrator-process-crash shape.
// Then opens the resulting file two ways:
//   1. McapIndexedReader (needs a footer) — expected to fail; confirms the
//      index path is NOT crash-tolerant on its own.
//   2. McapStreamReader (sequential, footerless) — reads whatever complete
//      records exist up to the truncation point.
//
// Run through the resolution shim (see ts-hooks.mjs), from playground/bench-recorder/:
//   /opt/homebrew/bin/node --import ../ts-hooks.mjs src/crash-recovery.ts --size=1.5 --compression=none

import { createRequire } from "node:module";
import { mkdir, stat, rm, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { McapIndexedReader, McapStreamReader } from "@mcap/core";
import { FileHandleReadable } from "@mcap/nodejs";
import { uncompressSync as lz4Uncompress } from "lz4-napi";
import { decompress as zstdDecompress } from "zstd-napi";
import {
  RAW_FRAME_MESSAGE_ENCODING,
  RAW_FRAME_SCHEMA_DATA,
  RAW_FRAME_SCHEMA_NAME,
} from "../../../docs/schema/fovea.ts";
import { McapWriterWorker } from "../../../app/orchestrator/recorder/writer.ts";
import type { CompressionInjection } from "../../../app/orchestrator/recorder/types.ts";
import { buildFramePool, buildProcessedPool } from "./synth.ts";

type Compression = "none" | "lz4" | "zstd";

function parseArgs() {
  const map = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) map.set(m[1]!, m[2]!);
  }
  return {
    size: Number(map.get("size") ?? "1.5"),
    compression: (map.get("compression") ?? "none") as Compression,
    zstdLevel: Number(map.get("zstdLevel") ?? "1"),
    runMs: Number(map.get("runMs") ?? "4000"),
    out: map.get("out") ?? "./out",
  };
}

function compressionInjection(
  compression: Compression,
  zstdLevel: number,
): CompressionInjection | undefined {
  if (compression === "none") return undefined;
  const require = createRequire(import.meta.url);
  if (compression === "lz4") {
    return { name: "lz4", moduleEntry: require.resolve("lz4-napi"), exportName: "compressSync" };
  }
  return {
    name: "zstd",
    moduleEntry: require.resolve("zstd-napi"),
    exportName: "compress",
    level: zstdLevel,
  };
}

interface Channel {
  topic: string;
  fps: number;
  metadata: Record<string, string>;
  pool: readonly Uint8Array[];
}

async function main(): Promise<void> {
  const args = parseArgs();
  await mkdir(args.out, { recursive: true });
  const filePath = `${args.out}/crash-${args.size}MiB-${args.compression}.fovea`;
  await rm(filePath, { force: true });

  const rawTargetBytes = Math.round(args.size * 1024 * 1024);
  const rawPool = buildFramePool(rawTargetBytes);
  const procPool = buildProcessedPool(Math.max(65536, Math.round(rawTargetBytes / 8)));

  const channels: Channel[] = [
    ...["cam0", "cam1", "cam2"].map((name) => ({
      topic: `raw/${name}`,
      fps: 60,
      metadata: {
        dtype: "U8",
        shape: JSON.stringify([rawPool.height, rawPool.width]),
        channels: "1",
        pixelFormat: "BayerRG12p",
        significantBits: "12",
      },
      pool: rawPool.frames,
    })),
    {
      topic: "processed/disparity",
      fps: 30,
      metadata: {
        dtype: "U8",
        shape: JSON.stringify([procPool.height, procPool.width]),
        channels: "1",
        pixelFormat: "Mono8",
        significantBits: "8",
      },
      pool: procPool.frames,
    },
  ];

  const writer = new McapWriterWorker(filePath, "crash", {
    chunkBytes: Math.round(rawTargetBytes * 1.05),
    session: { startedAt: new Date().toISOString(), bench: "crash-recovery" },
    compression: compressionInjection(args.compression, args.zstdLevel),
  });
  for (const ch of channels) {
    writer.registerChannel(ch.topic, {
      schema: RAW_FRAME_SCHEMA_NAME,
      schemaData: RAW_FRAME_SCHEMA_DATA,
      messageEncoding: RAW_FRAME_MESSAGE_ENCODING,
      metadata: ch.metadata,
    });
  }

  let seq = 0;
  let accepted = 0;
  let bytesAttempted = 0;
  const start = performance.now();
  let stop = false;
  function produce(ch: Channel, idx: number): void {
    if (stop || writer.error) return;
    const template = ch.pool[idx % ch.pool.length]!;
    bytesAttempted += template.byteLength;
    const ok = writer.writeFrame(ch.topic, seq++, BigInt(Math.round(performance.now() * 1e6)), () => {
      const data = new ArrayBuffer(template.byteLength);
      new Uint8Array(data).set(template);
      return data;
    });
    if (ok) accepted++;
    const period = 1000 / ch.fps;
    const nextDue = start + (idx + 1) * period;
    setTimeout(() => produce(ch, idx + 1), Math.max(0, nextDue - performance.now()));
  }
  channels.forEach((ch) => produce(ch, 0));

  await sleep(args.runMs);
  stop = true;
  // Simulate a hard crash: abort (terminate the worker WITHOUT finalize), so
  // McapWriter.end() never writes the footer/summary and whatever chunk is
  // still buffered in memory is lost — like a SIGKILL mid-recording.
  await sleep(50); // let in-flight frames actually reach the worker's chain
  await writer.abort();

  const fileBytes = (await stat(filePath).catch(() => undefined))?.size ?? 0;
  console.log(
    `[crash-recovery] size=${args.size}MiB compression=${args.compression} ` +
      `frames-sent=${seq} frames-accepted=${accepted} bytesAttempted=${bytesAttempted} fileBytesOnDisk=${fileBytes}`,
  );

  // 1) Indexed reader — expect failure (no footer).
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

  // 2) Streaming reader — read whatever complete records exist.
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
    writer: "production:McapWriterWorker",
    framesSentToWorker: seq,
    framesAcceptedByWriter: accepted,
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
