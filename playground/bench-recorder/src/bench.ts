// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Recorder container format bench (B-4, docs/refactor/recorder-container.md
// §2). Drives one MCAP file through a single writer-worker (mirroring
// stream-writer.ts's worker_threads architecture) at the target recorder
// workload: 3 raw streams @ 60fps + 1 processed stream @ 30fps, for a
// sustained duration, with a bounded per-channel handoff queue (drops are
// counted, not silently absorbed - see workload-metering.md's philosophy).
//
// Usage (must use /opt/homebrew/bin/node - bare node/npx are broken in this
// shell):
//   /opt/homebrew/bin/node src/bench.ts --size=1.5 --compression=none --duration=30
//   /opt/homebrew/bin/node src/bench.ts --size=6.2 --compression=zstd --duration=30 --zstdLevel=1
//
// Prints a human-readable live status line every 2s and a final line
// prefixed `RESULT:` with a single-line JSON summary for scripted collection
// across the compression x size matrix.

import { Worker } from "node:worker_threads";
import { mkdir, stat, rm } from "node:fs/promises";
import { cpus } from "node:os";
import { buildFramePool, buildProcessedPool } from "./synth.ts";
import type { WorkerIn, WorkerOut, Compression, ChannelSpec } from "./protocol.ts";

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

function parseArgs(): Args {
  const map = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) map.set(m[1]!, m[2]!);
  }
  const size = Number(map.get("size") ?? "1.5");
  const compression = (map.get("compression") ?? "none") as Compression;
  return {
    size,
    compression,
    zstdLevel: Number(map.get("zstdLevel") ?? "1"),
    duration: Number(map.get("duration") ?? "30"),
    maxQueued: Number(map.get("maxQueued") ?? "8"),
    chunkSizeMiB: Number(map.get("chunkSizeMiB") ?? String(size * 1.05)),
    out: map.get("out") ?? "./out",
    keep: map.get("keep") === "1",
  };
}

interface ChannelRuntime {
  spec: ChannelSpec;
  fps: number;
  pool: readonly Uint8Array[];
  poolIdx: number;
  seq: number;
  tick: number;
  queued: number;
  produced: number;
  dropped: number;
  acked: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  await mkdir(args.out, { recursive: true });
  const filePath = `${args.out}/bench-${args.size}MiB-${args.compression}.mcap`;
  await rm(filePath, { force: true });

  const rawTargetBytes = Math.round(args.size * 1024 * 1024);
  const processedTargetBytes = Math.max(65536, Math.round(rawTargetBytes / 8));
  const rawPool = buildFramePool(rawTargetBytes);
  const procPool = buildProcessedPool(processedTargetBytes);

  console.log(
    `[bench] raw frame ${rawPool.byteLength} bytes (${rawPool.width}x${rawPool.height} 12p) | ` +
      `processed frame ${procPool.byteLength} bytes (${procPool.width}x${procPool.height} 8-bit) | ` +
      `compression=${args.compression} duration=${args.duration}s chunkSize=${(args.chunkSizeMiB).toFixed(2)}MiB`,
  );

  const channels: ChannelRuntime[] = [
    ...["cam0", "cam1", "cam2"].map((name) => ({
      spec: {
        topic: `raw/${name}`,
        schemaName: "fovea.raw12p",
        metadata: {
          width: String(rawPool.width),
          height: String(rawPool.height),
          pixelFormat: "BayerRG12p",
          significantBits: "12",
        },
      },
      fps: 60,
      pool: rawPool.frames,
      poolIdx: 0,
      seq: 0,
      tick: 0,
      queued: 0,
      produced: 0,
      dropped: 0,
      acked: 0,
    })),
    {
      spec: {
        topic: "processed/disparity",
        schemaName: "fovea.processed8",
        metadata: {
          width: String(procPool.width),
          height: String(procPool.height),
          pixelFormat: "Mono8",
          significantBits: "8",
        },
      },
      fps: 30,
      pool: procPool.frames,
      poolIdx: 0,
      seq: 0,
      tick: 0,
      queued: 0,
      produced: 0,
      dropped: 0,
      acked: 0,
    },
  ];
  const channelsByTopic = new Map(channels.map((c) => [c.spec.topic, c]));

  const workerUrl = new URL("./writer-worker.ts", import.meta.url);
  const worker = new Worker(workerUrl);

  let ready = false;
  let stopped: Extract<WorkerOut, { type: "stopped" }> | undefined;
  let lastError: string | undefined;
  const rssSamples: number[] = [];

  let workerReadyAt = 0;
  let workerStoppedAt = 0;
  worker.on("message", (msg: WorkerOut) => {
    if (msg.type === "ready") {
      ready = true;
      workerReadyAt = performance.now();
      return;
    }
    if (msg.type === "ack") {
      const ch = channelsByTopic.get(msg.topic);
      if (ch) {
        ch.queued = Math.max(0, ch.queued - 1);
        ch.acked++;
      }
      return;
    }
    if (msg.type === "metrics") {
      // Live RSS trend only - CPU% is computed authoritatively from the
      // "stopped" message's start/end diff (see below), since these
      // periodic samples can have gaps if the worker's event loop is
      // saturated with writes and delays handling metrics-request.
      rssSamples.push(msg.rss);
      return;
    }
    if (msg.type === "stopped") {
      stopped = msg;
      workerStoppedAt = performance.now();
      return;
    }
    if (msg.type === "error") {
      lastError = msg.message;
      console.error("[bench] worker error:", msg.message, msg.stack);
    }
  });

  const init: WorkerIn = {
    type: "init",
    filePath,
    chunkSize: Math.round(args.chunkSizeMiB * 1024 * 1024),
    compression: args.compression,
    zstdLevel: args.zstdLevel,
    channels: channels.map((c) => c.spec),
  };
  worker.postMessage(init);
  while (!ready && !lastError) await sleep(5);
  if (lastError) throw new Error(`init failed: ${lastError}`);

  const mainCpuStart = process.cpuUsage();
  const wallStart = performance.now();
  let stop = false;

  function produce(ch: ChannelRuntime): void {
    if (stop) return;
    if (ch.queued >= args.maxQueued) {
      ch.dropped++;
    } else {
      const template = ch.pool[ch.poolIdx % ch.pool.length]!;
      ch.poolIdx++;
      // Real copy-then-transfer, matching stream-writer.ts's write() path
      // (frames must be copied out of the shared camera/shm buffer before
      // handoff to the worker).
      const data = new ArrayBuffer(template.byteLength);
      new Uint8Array(data).set(template);
      const logTimeNs = BigInt(Math.round(performance.now() * 1e6));
      ch.queued++;
      ch.produced++;
      const seq = ch.seq++;
      worker.postMessage(
        { type: "frame", topic: ch.spec.topic, seq, logTimeNs, data } satisfies WorkerIn,
        [data],
      );
    }
    // Scheduling anchor is the source's true arrival clock (ch.tick), NOT
    // the count of frames actually accepted - a real camera keeps ticking
    // at its hardware fps regardless of whether the recorder queue is full,
    // so drops must not slow down the next-frame schedule.
    ch.tick++;
    const period = 1000 / ch.fps;
    const nextDue = wallStart + ch.tick * period;
    const delay = Math.max(0, nextDue - performance.now());
    setTimeout(() => produce(ch), delay);
  }
  for (const ch of channels) produce(ch);

  const statusTimer = setInterval(() => {
    worker.postMessage({ type: "metrics-request" } satisfies WorkerIn);
    const elapsed = (performance.now() - wallStart) / 1000;
    const parts = channels
      .map(
        (c) =>
          `${c.spec.topic}=src${(c.tick / elapsed).toFixed(1)}/wr${(c.produced / elapsed).toFixed(1)}fps ` +
          `drop${c.dropped}(${((100 * c.dropped) / Math.max(1, c.tick)).toFixed(0)}%) q${c.queued}`,
      )
      .join(" ");
    console.log(`[t=${elapsed.toFixed(1)}s] ${parts}`);
  }, 2000);

  await sleep(args.duration * 1000);
  stop = true;
  clearInterval(statusTimer);
  const wallElapsed = (performance.now() - wallStart) / 1000;
  const mainCpuEnd = process.cpuUsage(mainCpuStart);

  // drain: wait for queues to empty (bounded, so this should be quick)
  const drainStart = performance.now();
  while (channels.some((c) => c.queued > 0) && performance.now() - drainStart < 10000) {
    await sleep(20);
  }

  worker.postMessage({ type: "stop" } satisfies WorkerIn);
  const stopStart = performance.now();
  while (!stopped && !lastError && performance.now() - stopStart < 30000) await sleep(20);
  await worker.terminate();

  const fileStat = await stat(filePath).catch(() => undefined);
  const fileBytes = fileStat?.size ?? 0;
  // args.keep is a hint for callers that want to inspect the file afterward
  // (verify-seek.ts/crash-recovery.ts manage their own files independently);
  // the bench itself never deletes its own output.
  void args.keep;

  const ncpus = cpus().length;
  const bytesWrittenActual = stopped?.bytesWritten ?? 0;

  const summary = {
    size: args.size,
    compression: args.compression,
    zstdLevel: args.compression === "zstd" ? args.zstdLevel : undefined,
    durationTargetSec: args.duration,
    wallElapsedSec: Number(wallElapsed.toFixed(2)),
    chunkSizeMiB: args.chunkSizeMiB,
    channels: channels.map((c) => ({
      topic: c.spec.topic,
      targetFps: c.fps,
      sourceFps: Number((c.tick / wallElapsed).toFixed(2)),
      writtenFps: Number((c.produced / wallElapsed).toFixed(2)),
      produced: c.produced,
      dropped: c.dropped,
      dropPct: Number(((100 * c.dropped) / Math.max(1, c.tick)).toFixed(1)),
      acked: c.acked,
    })),
    rawFrameBytes: rawPool.byteLength,
    processedFrameBytes: procPool.byteLength,
    bytesWrittenLogical: bytesWrittenActual,
    fileBytesOnDisk: fileBytes,
    compressionRatio: fileBytes > 0 ? Number((bytesWrittenActual / fileBytes).toFixed(3)) : null,
    sustainedMBps: Number((bytesWrittenActual / wallElapsed / (1024 * 1024)).toFixed(2)),
    sustainedMBpsOnDisk: Number((fileBytes / wallElapsed / (1024 * 1024)).toFixed(2)),
    mainThreadCpuPctOfOneCore: Number(
      (((mainCpuEnd.user + mainCpuEnd.system) / 1000 / (wallElapsed * 1000)) * 100).toFixed(1),
    ),
    // Normalized against the worker's own observed lifetime (ready -> stopped),
    // which runs a bit longer than wallElapsed because of end-of-run drain.
    workerCpuPctOfOneCore: stopped
      ? Number(
          (
            ((stopped.cpuUserUs + stopped.cpuSystemUs) /
              1000 /
              Math.max(1, workerStoppedAt - workerReadyAt)) *
            100
          ).toFixed(1),
        )
      : null,
    machineCores: ncpus,
    rssMinMB: rssSamples.length ? Number((Math.min(...rssSamples) / 1024 / 1024).toFixed(1)) : null,
    rssMaxMB: rssSamples.length ? Number((Math.max(...rssSamples) / 1024 / 1024).toFixed(1)) : null,
    chunkCount: stopped?.chunkCount ?? null,
    messageCount: stopped?.messageCount ?? null,
    error: lastError ?? null,
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
