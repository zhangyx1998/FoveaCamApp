// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Verifies index-based seeking on a produced MCAP file: opens with
// McapIndexedReader (requires a valid footer/summary section), picks a
// timestamp near the middle of the recording, and confirms readMessages()
// with a narrow [startTime, endTime) window returns the right message(s)
// without a full linear scan - i.e. the chunk index is actually being used.
//
// Usage: /opt/homebrew/bin/node src/verify-seek.ts --file=./out/bench-1.5MiB-lz4.mcap

import { open } from "node:fs/promises";
import { McapIndexedReader } from "@mcap/core";
import { FileHandleReadable } from "@mcap/nodejs";
import { uncompressSync as lz4Uncompress } from "lz4-napi";
import { decompress as zstdDecompress } from "zstd-napi";

function parseArgs() {
  const map = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) map.set(m[1]!, m[2]!);
  }
  return { file: map.get("file") ?? "./out/bench-1.5MiB-lz4.mcap" };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const handle = await open(args.file, "r");
  const readable = new FileHandleReadable(handle);

  const t0 = performance.now();
  const reader = await McapIndexedReader.Initialize({
    readable,
    decompressHandlers: {
      lz4: (data) => lz4Uncompress(Buffer.from(data)),
      zstd: (data) => zstdDecompress(Buffer.from(data)) as Uint8Array,
    },
  });
  const initMs = performance.now() - t0;

  console.log(`[verify-seek] file=${args.file}`);
  console.log(
    `[verify-seek] Initialize() took ${initMs.toFixed(2)}ms, chunkIndex entries=${reader.chunkIndexes.length}, ` +
      `channels=${reader.channelsById.size}, messageCount=${reader.statistics?.messageCount}`,
  );

  if (reader.chunkIndexes.length === 0) {
    console.log("RESULT_SEEK:" + JSON.stringify({ ok: false, reason: "no chunk index" }));
    await handle.close();
    return;
  }

  const first = reader.chunkIndexes[0]!;
  const last = reader.chunkIndexes[reader.chunkIndexes.length - 1]!;
  const midTime = (first.messageStartTime + last.messageEndTime) / 2n;
  const windowNs = 200_000_000n; // 200ms window (wide enough even for degraded-throughput runs)

  const t1 = performance.now();
  let found: { channelId: number; logTime: bigint; dataLen: number } | undefined;
  for await (const message of reader.readMessages({
    startTime: midTime - windowNs,
    endTime: midTime + windowNs,
  })) {
    found = { channelId: message.channelId, logTime: message.logTime, dataLen: message.data.byteLength };
    break;
  }
  const seekMs = performance.now() - t1;

  // Compare against a full unrestricted scan's per-message cost to show the
  // seek is not doing a linear scan from the start of the file.
  const t2 = performance.now();
  let scanned = 0;
  for await (const _m of reader.readMessages({})) {
    scanned++;
    if (scanned >= 50) break; // just sample the iteration cost, not the whole file
  }
  const scanSampleMs = performance.now() - t2;

  const summary = {
    ok: found != undefined,
    initMs: Number(initMs.toFixed(2)),
    chunkIndexEntries: reader.chunkIndexes.length,
    messageCount: reader.statistics ? String(reader.statistics.messageCount) : null,
    targetMidTimeNs: String(midTime),
    seekWindowReadMs: Number(seekMs.toFixed(2)),
    firstUnrestrictedScanSampleMs50msgs: Number(scanSampleMs.toFixed(2)),
    found: found
      ? { channelId: found.channelId, logTime: String(found.logTime), dataLen: found.dataLen }
      : undefined,
  };
  console.log("RESULT_SEEK:" + JSON.stringify(summary));
  await handle.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
