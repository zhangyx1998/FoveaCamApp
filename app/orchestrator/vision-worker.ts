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
        const out = await kernel.process(read);
        if (out) postResult(out.values, out.frames);
      } catch (e) {
        fail(`vision step failed: ${(e as Error).message}`);
      }
    }
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
