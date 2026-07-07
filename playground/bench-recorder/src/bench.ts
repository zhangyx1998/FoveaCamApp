// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Recorder container-format bench (B-4, docs/refactor/recorder-container.md
// §2). B-P4: this is now a THIN HARNESS around the PRODUCTION recorder writer
// (app/orchestrator/recorder/writer.ts → McapWriterWorker + its eval'd worker
// source), not a sibling MCAP writer. So the throughput/drop numbers below are
// measured against the exact code path users record through. The only bench-
// only addition is chunk compression, injected through the production writer's
// `compression` seam (lazy-required in the worker; production ships no
// compressor and stays uncompressed — B-4 showed compression on the single
// writer chain worsens the bottleneck).
//
// Workload: 3 raw streams @ 60fps + 1 processed stream @ 30fps, sustained for
// `--duration`s, with the production writer's bounded per-channel in-flight
// window refusing (dropping) frames under backpressure — drops are counted,
// not silently absorbed (workload-metering.md philosophy).
//
// Must run through the resolution shim so the production ESM loads under raw
// node (bare node/npx are broken in this shell):
//   /opt/homebrew/bin/node --import ../ts-hooks.mjs src/bench.ts --size=1.5 --compression=none --duration=30
//   /opt/homebrew/bin/node --import ../ts-hooks.mjs src/bench.ts --size=6.2 --compression=zstd --zstdLevel=1
// (run from playground/bench-recorder/; --import path is relative to cwd.)
//
// Prints a live status line every 2s and a final `RESULT:` line with a
// single-line JSON summary for scripted collection across the compression x
// size matrix.

import { mkdir, stat, rm } from "node:fs/promises";
import { cpus } from "node:os";
import {
  RAW_FRAME_MESSAGE_ENCODING,
  RAW_FRAME_SCHEMA_DATA,
  RAW_FRAME_SCHEMA_NAME,
} from "../../../docs/schema/fovea.ts";
import { McapWriterWorker } from "../../../app/orchestrator/recorder/writer.ts";
import { buildFramePool, buildProcessedPool } from "./synth.ts";
import {
  benchChannels,
  compressionInjection,
  parseArgs,
  type BenchChannel,
  type Compression,
} from "./harness.ts";

interface Args {
  size: number; // MiB target for raw streams
  compression: Compression;
  zstdLevel: number;
  duration: number; // seconds
  maxQueued: number;
  chunkSizeMiB: number;
  out: string;
  keep: boolean;
}

interface Channel extends BenchChannel {
  poolIdx: number;
  seq: number;
  tick: number;
  produced: number;
  dropped: number;
}

async function main(): Promise<void> {
  const args = parseArgs<Args>(
    {
      size: 1.5,
      compression: "none",
      zstdLevel: 1,
      duration: 30,
      maxQueued: 8,
      chunkSizeMiB: Number.NaN,
      out: "./out",
      keep: false,
    },
    ["keep"],
  );
  if (Number.isNaN(args.chunkSizeMiB)) args.chunkSizeMiB = args.size * 1.05;
  await mkdir(args.out, { recursive: true });
  const filePath = `${args.out}/bench-${args.size}MiB-${args.compression}.fovea`;
  await rm(filePath, { force: true });

  const rawTargetBytes = Math.round(args.size * 1024 * 1024);
  const processedTargetBytes = Math.max(65536, Math.round(rawTargetBytes / 8));
  const rawPool = buildFramePool(rawTargetBytes);
  const procPool = buildProcessedPool(processedTargetBytes);

  console.log(
    `[bench] raw frame ${rawPool.byteLength} bytes (${rawPool.width}x${rawPool.height} 12p) | ` +
      `processed frame ${procPool.byteLength} bytes (${procPool.width}x${procPool.height} 8-bit) | ` +
      `compression=${args.compression} duration=${args.duration}s chunkSize=${args.chunkSizeMiB.toFixed(2)}MiB | ` +
      `writer=production McapWriterWorker`,
  );

  const channels: Channel[] = benchChannels(rawPool, procPool).map(
    (channel) => ({
      ...channel,
      poolIdx: 0,
      seq: 0,
      tick: 0,
      produced: 0,
      dropped: 0,
    }),
  );

  const writer = new McapWriterWorker(filePath, "bench", {
    chunkBytes: Math.round(args.chunkSizeMiB * 1024 * 1024),
    maxQueuedFrames: args.maxQueued,
    session: { startedAt: new Date().toISOString(), bench: "recorder-throughput" },
    compression: compressionInjection(args),
  });
  for (const ch of channels) {
    writer.registerChannel(ch.topic, {
      schema: RAW_FRAME_SCHEMA_NAME,
      schemaData: RAW_FRAME_SCHEMA_DATA,
      messageEncoding: RAW_FRAME_MESSAGE_ENCODING,
      metadata: ch.metadata,
    });
  }

  const rssSamples: number[] = [];
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  let stop = false;

  function produce(ch: Channel): void {
    if (stop || writer.error) return;
    const template = ch.pool[ch.poolIdx % ch.pool.length]!;
    ch.poolIdx++;
    const logTimeNs = BigInt(Math.round(performance.now() * 1e6));
    // The production writer REFUSES (returns false, without invoking the copy
    // thunk) when the channel's in-flight window is full — that refusal is the
    // single-writer-chain bottleneck surfacing as a drop.
    const accepted = writer.writeFrame(ch.topic, ch.seq++, logTimeNs, () => {
      // Real copy-then-transfer: frames must be copied out of the shared
      // camera/shm buffer before handoff (the writer transfers the ArrayBuffer).
      const data = new ArrayBuffer(template.byteLength);
      new Uint8Array(data).set(template);
      return data;
    });
    if (accepted) ch.produced++;
    else ch.dropped++;
    // Scheduling anchor is the source's true arrival clock (ch.tick), NOT the
    // count accepted — a real camera keeps ticking at its hardware fps whether
    // or not the recorder queue is full, so drops must not slow the schedule.
    ch.tick++;
    const period = 1000 / ch.fps;
    const nextDue = wallStart + ch.tick * period;
    setTimeout(() => produce(ch), Math.max(0, nextDue - performance.now()));
  }
  for (const ch of channels) produce(ch);

  const statusTimer = setInterval(() => {
    rssSamples.push(process.memoryUsage().rss);
    const elapsed = (performance.now() - wallStart) / 1000;
    const parts = channels
      .map(
        (c) =>
          `${c.topic}=src${(c.tick / elapsed).toFixed(1)}/wr${(c.produced / elapsed).toFixed(1)}fps ` +
          `drop${c.dropped}(${((100 * c.dropped) / Math.max(1, c.tick)).toFixed(0)}%) q${writer.queueDepth(c.topic)}`,
      )
      .join(" ");
    console.log(`[t=${elapsed.toFixed(1)}s] ${parts}`);
  }, 2000);

  await sleep(args.duration * 1000);
  stop = true;
  clearInterval(statusTimer);

  // Drain: wait for the production writer's in-flight windows to empty (bounded,
  // so quick) before finalizing.
  const drainStart = performance.now();
  while (
    channels.some((c) => writer.queueDepth(c.topic) > 0) &&
    !writer.error &&
    performance.now() - drainStart < 10000
  ) {
    await sleep(20);
  }

  let finalizeError: string | undefined;
  const stats = await writer
    .finalize({ durationSec: String(((performance.now() - wallStart) / 1000).toFixed(2)) })
    .catch((error: unknown) => {
      finalizeError = error instanceof Error ? error.message : String(error);
      return undefined;
    });

  const wallElapsed = (performance.now() - wallStart) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  const fileBytes = (await stat(filePath).catch(() => undefined))?.size ?? 0;
  const bytesOnDisk = stats?.bytes ?? 0;
  // Logical (uncompressed) payload the source actually got written — the
  // production worker only reports on-disk position, so the bench derives this
  // from accepted-frame counts to report raw ingest throughput + a real
  // compression ratio.
  const frameBytesFor = (topic: string) =>
    topic.startsWith("raw/") ? rawPool.byteLength : procPool.byteLength;
  const bytesLogical = channels.reduce(
    (sum, c) => sum + c.produced * frameBytesFor(c.topic),
    0,
  );
  void args.keep; // the bench never deletes its own output

  const summary = {
    size: args.size,
    compression: args.compression,
    zstdLevel: args.compression === "zstd" ? args.zstdLevel : undefined,
    durationTargetSec: args.duration,
    wallElapsedSec: Number(wallElapsed.toFixed(2)),
    chunkSizeMiB: args.chunkSizeMiB,
    writer: "production:McapWriterWorker",
    channels: channels.map((c) => ({
      topic: c.topic,
      targetFps: c.fps,
      sourceFps: Number((c.tick / wallElapsed).toFixed(2)),
      writtenFps: Number((c.produced / wallElapsed).toFixed(2)),
      produced: c.produced,
      dropped: c.dropped,
      dropPct: Number(((100 * c.dropped) / Math.max(1, c.tick)).toFixed(1)),
    })),
    rawFrameBytes: rawPool.byteLength,
    processedFrameBytes: procPool.byteLength,
    bytesLogical,
    bytesOnDisk,
    fileBytesOnDisk: fileBytes,
    compressionRatio: fileBytes > 0 ? Number((bytesLogical / fileBytes).toFixed(3)) : null,
    // Raw ingest throughput (logical payload accepted per wall-second) — the
    // B-4 headline metric.
    sustainedMBps: Number((bytesLogical / wallElapsed / (1024 * 1024)).toFixed(2)),
    sustainedMBpsOnDisk: Number((fileBytes / wallElapsed / (1024 * 1024)).toFixed(2)),
    // Whole-process CPU (main thread + the writer worker thread share one OS
    // process, so process.cpuUsage() covers both) as a fraction of one core.
    processCpuPctOfOneCore: Number(
      (((cpu.user + cpu.system) / 1000 / (wallElapsed * 1000)) * 100).toFixed(1),
    ),
    machineCores: cpus().length,
    rssMinMB: rssSamples.length ? Number((Math.min(...rssSamples) / 1024 / 1024).toFixed(1)) : null,
    rssMaxMB: rssSamples.length ? Number((Math.max(...rssSamples) / 1024 / 1024).toFixed(1)) : null,
    chunkCount: stats?.chunkCount ?? null,
    messageCount: stats?.messageCount ?? null,
    error: finalizeError ?? writer.error?.message ?? null,
    filePath,
  };

  console.log("RESULT:" + JSON.stringify(summary));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
