// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Per-session VISION WORKER entry (C-22b, WS1 real-1f). Bundled as its own
// electron build entry (A-28) → `.dist/electron/vision-worker.js`, spawned by
// `vision-worker-host.ts` (`new Worker(".../vision-worker.js")`). This is the
// session-agnostic host: it owns SHM I/O (the reader addon), framing, and the
// MessagePort transport; the actual pixel work is a `VisionKernel` it dispatches
// to by `params.kind`.
//
// READ-ONLY SHM: it `reader.open`s the parent-brokered `shmName`s and never
// touches the broker/gate (main owns connect/disconnect — keeps the C-21 gate a
// main-thread-only, race-free single writer). One frame at a time, awaited
// sequentially, so a kernel step is naturally non-reentrant.

import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { makeMat } from "@lib/mat";
import type { Mat } from "core/Vision";
import type { KernelFactory, VisionKernel, FrameSet } from "./vision-kernel.js";
import type {
  DerivedFrame,
  PipeInput,
  VisionInit,
  VisionResult,
  VisionWorkerIn,
} from "./vision-worker-protocol.js";
import { createDisparityKernel } from "@modules/disparity-scope/vision";
import { createDisplayKernel } from "./display-kernel.js";
import { createDistortionKernel } from "@modules/calibrate-distortion/vision";
import { createCheckerKernel } from "@modules/calibrate-intrinsic/vision";

/** Kernel registry — keyed by `params.kind`. `display` serves tracking-single +
 *  manual-control + multi-fovea (center only); `distortion`/`checker` serve the
 *  calibrate apps (C-22b step 2/3). */
const KERNELS: Record<string, KernelFactory> = {
  disparity: createDisparityKernel,
  display: createDisplayKernel,
  distortion: createDistortionKernel,
  checker: createCheckerKernel,
};

/** Idle backoff when no pipe produced a new frame (yield-loop, ~1-3ms). */
const BACKOFF_MS = 2;

const requireHere = createRequire(import.meta.url);
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The reader addon's JS surface (see core/reader/ShmReaderAddon.cpp). */
interface ReaderAddon {
  open(name: string): unknown;
  readInto(
    handle: unknown,
    dst: ArrayBufferView,
    lastSeq: bigint,
  ):
    | null
    | { closed: true }
    | {
        seq: bigint;
        gen: number;
        width: number;
        height: number;
        originX: number; // v4: frame-bound crop origin (0/0 = uncropped)
        originY: number;
        meta: { deviceTimestamp?: bigint; systemTimestamp?: bigint };
      };
  close(handle: unknown): void;
}

type OpenPipe = {
  input: PipeInput;
  handle: unknown;
  buffer: Uint8Array;
  lastSeq: bigint;
};

const port = parentPort;
if (!port) throw new Error("vision-worker must run as a worker_thread");

let running = false;
let kernel: VisionKernel | null = null;
let addon: ReaderAddon | null = null;
let pipes: OpenPipe[] = [];

// --- self-meter (VisionInit.meterName) -------------------------------------
// Kernel busy time, per-role input counts, latest-wins SKIPS as drops (ring
// seq gaps = frames the kernel never saw), result rate + max result gap.
// Cumulative counts; rates/utilization are per-report-interval deltas.
const STATS_INTERVAL_MS = 1000;
let meterName: string | null = null;
const meter = {
  startedAt: 0,
  busyMs: 0,
  inputs: new Map<string, number>(),
  dropsTotal: 0,
  results: 0,
  // per-interval baselines
  lastReportAt: 0,
  lastBusyMs: 0,
  lastInputs: new Map<string, number>(),
  lastDrops: 0,
  lastResults: 0,
  lastResultAt: 0,
  maxResultGapMs: 0,
};

function reportStats(now: number): void {
  if (!meterName || now - meter.lastReportAt < STATS_INTERVAL_MS) return;
  const dt = (now - meter.lastReportAt) / 1000;
  const inputs: Record<string, { count: number; ratePerSec: number }> = {};
  for (const [role, count] of meter.inputs) {
    inputs[role] = {
      count,
      ratePerSec: (count - (meter.lastInputs.get(role) ?? 0)) / dt,
    };
    meter.lastInputs.set(role, count);
  }
  port!.postMessage({
    kind: "stats",
    workload: {
      name: meterName,
      window: { startedAt: meter.startedAt, snapshotAt: now, uptimeMs: now - meter.startedAt },
      utilization: Math.min(1, (meter.busyMs - meter.lastBusyMs) / (now - meter.lastReportAt)),
      busyMs: meter.busyMs,
      inputs,
      outputs: {
        result: {
          count: meter.results,
          ratePerSec: (meter.results - meter.lastResults) / dt,
          maxIntervalMs: meter.maxResultGapMs,
        },
      },
      drops: {
        total: meter.dropsTotal,
        ratePerSec: (meter.dropsTotal - meter.lastDrops) / dt,
        byReason: {},
      },
    },
  });
  meter.lastReportAt = now;
  meter.lastBusyMs = meter.busyMs;
  meter.lastDrops = meter.dropsTotal;
  meter.lastResults = meter.results;
  meter.maxResultGapMs = 0;
}

function fail(message: string): void {
  port!.postMessage({ kind: "error", message });
}

function start(init: VisionInit): void {
  try {
    addon = requireHere(init.readerPath) as ReaderAddon;
  } catch (e) {
    fail(`reader addon load failed: ${(e as Error).message}`);
    return;
  }
  const kind = String((init.params as { kind?: unknown }).kind ?? "disparity");
  const factory = KERNELS[kind];
  if (!factory) {
    fail(`unknown vision kernel: ${kind}`);
    return;
  }
  kernel = factory(init.params);
  pipes = init.pipes.map((input) => ({
    input,
    handle: addon!.open(input.shmName),
    buffer: new Uint8Array(input.bytesPerFrame),
    lastSeq: 0n,
  }));
  meterName = init.meterName ?? null;
  meter.startedAt = meter.lastReportAt = Date.now();
  running = true;
  void pump();
}

/** Read every pipe once; return the frames new since last tick (latest-wins). */
function readFrames(): FrameSet | "closed" {
  const frames: FrameSet = {};
  for (const pipe of pipes) {
    const r = addon!.readInto(pipe.handle, pipe.buffer, pipe.lastSeq);
    if (r === null) continue;
    if ("closed" in r) return "closed";
    // Meter: consumed one frame; seq gaps = frames latest-wins skipped while
    // the kernel was busy (the throughput-loss signal for a kernel-bound app).
    const role = pipe.input.role;
    meter.inputs.set(role, (meter.inputs.get(role) ?? 0) + 1);
    if (pipe.lastSeq > 0n && r.seq > pipe.lastSeq + 1n)
      meter.dropsTotal += Number(r.seq - pipe.lastSeq - 1n);
    pipe.lastSeq = r.seq;
    const len = r.width * r.height * pipe.input.channels;
    const view = new Uint8Array(pipe.buffer.buffer, pipe.buffer.byteOffset, len);
    frames[pipe.input.role] = {
      mat: makeMat(view, [r.height, r.width], pipe.input.channels),
      seq: Number(r.seq),
      originX: r.originX,
      originY: r.originY,
      deviceTimestamp: r.meta.deviceTimestamp !== undefined ? Number(r.meta.deviceTimestamp) : undefined,
    };
  }
  return frames;
}

/** Copy kernel output frames into fresh transferable buffers and post. */
function postResult(values: Record<string, unknown>, mats: { name: string; mat: Mat<Uint8Array> }[]): void {
  const transfer: ArrayBuffer[] = [];
  const derived: DerivedFrame[] = mats.map(({ name, mat }) => {
    const [h = 0, w = 0] = mat.shape;
    // Fresh, transferable copy (transfer neuters it) — the read buffers are
    // always plain `ArrayBuffer`s (`new Uint8Array(bytesPerFrame)`).
    const buffer = mat.buffer.slice(
      mat.byteOffset,
      mat.byteOffset + mat.byteLength,
    ) as ArrayBuffer;
    transfer.push(buffer);
    return { name, buffer, width: w, height: h, channels: mat.channels };
  });
  const msg: VisionResult = {
    kind: "result",
    seq: typeof values.seq === "number" ? values.seq : undefined,
    deviceTimestamp: typeof values.deviceTimestamp === "number" ? values.deviceTimestamp : undefined,
    values,
    frames: derived,
  };
  port!.postMessage(msg, transfer);
}

async function pump(): Promise<void> {
  while (running) {
    let read: FrameSet | "closed";
    try {
      read = readFrames();
    } catch (e) {
      fail(`read failed: ${(e as Error).message}`);
      break;
    }
    if (read === "closed") break;
    const hasFrame = Object.keys(read).length > 0;
    if (hasFrame && kernel) {
      try {
        const t0 = performance.now();
        const out = await kernel.process(read);
        meter.busyMs += performance.now() - t0;
        if (out) {
          postResult(out.values, out.frames);
          const now = Date.now();
          if (meter.lastResultAt > 0)
            meter.maxResultGapMs = Math.max(meter.maxResultGapMs, now - meter.lastResultAt);
          meter.lastResultAt = now;
          meter.results++;
        }
      } catch (e) {
        fail(`vision step failed: ${(e as Error).message}`);
      }
    }
    reportStats(Date.now());
    await delay(hasFrame ? 0 : BACKOFF_MS);
  }
  cleanup();
}

function cleanup(): void {
  running = false;
  kernel?.dispose();
  kernel = null;
  if (addon) for (const pipe of pipes) try { addon.close(pipe.handle); } catch { /* already gone */ }
  pipes = [];
}

port.on("message", (msg: VisionWorkerIn) => {
  switch (msg.kind) {
    case "init":
      if (!running) start(msg);
      break;
    case "params":
      kernel?.setParams(msg.params);
      break;
    case "stop":
      running = false; // pump() falls through to cleanup on its next lap
      break;
  }
});
