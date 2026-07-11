// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Main-window preload: shared bridge + shm frame reader. Runs `sandbox: false`
// (required to load the native reader addon); the frame-only profiler window
// stays sandboxed. Self-contained per its own build pass (V11).
import path from "node:path";
import { installBridge } from "./preload-bridge";
import type { FramePayload } from "@lib/orchestrator/protocol";
import {
  withShmReadResult,
  type ShmReadResult,
} from "@lib/orchestrator/frame-payload";
import {
  PIPE_READ,
  PIPE_READ_DONE,
  PIPE_READ_SEQ,
  PIPE_READ_SEQ_DONE,
  SHM_INIT,
  SHM_READ,
  SHM_READ_DONE,
  type PipeReadRequest,
  type PipeReadSeqRequest,
  type ShmReadRequest,
} from "@lib/orchestrator/shm-messages";

type ReaderHandle = object;
/** A closed pipe read (C-17): explicit signal, distinct from `null` (no new
 *  frame) — the reader addon returns this once the publisher sets state=CLOSED. */
type ReaderClosed = { closed: true };
/** FIFO reader outcomes (capture-recorder-nodes Phase 0): `wantSeq` isn't
 *  published yet (poll again), or its ring slot was recycled (jump to
 *  `oldestSeq`, drop-account the gap). Ok/Closed reuse the readInto shapes. */
type ReaderNotYet = { notYet: true };
type ReaderGone = { gone: true; oldestSeq: bigint };
type ReaderAddon = {
  open(seg: string): ReaderHandle;
  readInto(
    handle: ReaderHandle,
    dest: ArrayBuffer,
    lastSeq: bigint,
  ): ShmReadResult | ReaderClosed | null;
  readSeqInto(
    handle: ReaderHandle,
    dest: ArrayBuffer,
    wantSeq: bigint,
  ): ShmReadResult | ReaderNotYet | ReaderGone | ReaderClosed | null;
  close(handle: ReaderHandle): void;
};

const isClosed = (r: unknown): r is ReaderClosed =>
  typeof r === "object" && r !== null && (r as ReaderClosed).closed === true;
const isNotYet = (r: unknown): r is ReaderNotYet =>
  typeof r === "object" && r !== null && (r as ReaderNotYet).notYet === true;
const isGone = (r: unknown): r is ReaderGone =>
  typeof r === "object" && r !== null && (r as ReaderGone).gone === true;

// This bundle is emitted as CommonJS (unsandboxed preloads load `.mjs` as
// real ESM where bare `require` throws — V11b), so the module wrapper's own
// `require` is available at runtime. Do NOT use
// `createRequire(import.meta.url)`: vite's CJS shim for `import.meta.url`
// resolves via `document.baseURI` in a preload (a preload has a `document`),
// which yields the dev server's http URL and `createRequire` rejects it
// (V11c — the "Received 'http://localhost:5173/…'" boot failure).
declare const require: NodeRequire;

const coreEntry = require.resolve("core");
const runtime = process.versions.electron ? "electron" : "node";
const version = process.versions[runtime]!;
const readerPath = path.join(
  path.dirname(coreEntry),
  ".bin",
  `${runtime}-${version}-${process.arch}-shm-reader.node`,
);
const reader = require(readerPath) as ReaderAddon;
const handles = new Map<string, { gen: number; handle: ReaderHandle }>();

function handleFor(seg: string, gen: number): ReaderHandle {
  const cached = handles.get(seg);
  if (cached?.gen === gen) return cached.handle;
  if (cached) reader.close(cached.handle);
  const handle = reader.open(seg);
  handles.set(seg, { gen, handle });
  return handle;
}

function readShmFrame(payload: FramePayload, dest: ArrayBuffer): FramePayload | null {
  if (!payload.shm) return null;
  const handle = handleFor(payload.shm.seg, payload.shm.gen);
  const lastSeq = payload.shm.seq > 0n ? payload.shm.seq - 1n : 0n;
  const result = reader.readInto(handle, dest, lastSeq);
  if (!result || isClosed(result)) return null;
  return withShmReadResult(
    payload as FramePayload & { shm: NonNullable<FramePayload["shm"]> },
    dest,
    result,
  );
}

// Pipe consumer reads (C-17): keyed by segment NAME with a consumer-tracked
// lastSeq (no per-frame descriptor). Handles cached by name; the reader addon
// reuses the transferred `buffer` as its dest (C-15).
const pipeHandles = new Map<string, ReaderHandle>();

function pipeHandleFor(shmName: string): ReaderHandle {
  let handle = pipeHandles.get(shmName);
  if (!handle) {
    handle = reader.open(shmName);
    pipeHandles.set(shmName, handle);
  }
  return handle;
}

function handlePipeRead(port: MessagePort, msg: PipeReadRequest): void {
  try {
    const handle = pipeHandleFor(msg.shmName);
    const result = reader.readInto(handle, msg.buffer, msg.lastSeq);
    if (isClosed(result)) {
      // Drop the cached handle so a re-advertised pipe re-opens fresh.
      reader.close(handle);
      pipeHandles.delete(msg.shmName);
      port.postMessage({ kind: PIPE_READ_DONE, id: msg.id, buffer: msg.buffer, closed: true }, [
        msg.buffer,
      ]);
      return;
    }
    port.postMessage(
      {
        kind: PIPE_READ_DONE,
        id: msg.id,
        buffer: msg.buffer,
        seq: result ? result.seq : undefined,
        tCapture: result ? result.meta?.tCapture : undefined,
        // A-26 Fix D: forward the convert cost + seqlock health the reader
        // already computed so the StreamView inspector lights up on pipes.
        convertMs: result ? result.meta?.convertMs : undefined,
        gen: result ? result.gen : undefined,
        retries: result ? result.retries : undefined,
        width: result ? result.width : undefined,
        height: result ? result.height : undefined,
        // v4: frame-bound crop origin (fovea pipes; 0/0 elsewhere).
        originX: result ? result.originX : undefined,
        originY: result ? result.originY : undefined,
        // v5: actual blob length for a compressed pipe (absent on dim-derived).
        bytes: result ? result.bytes : undefined,
      },
      [msg.buffer],
    );
  } catch (error) {
    port.postMessage(
      {
        kind: PIPE_READ_DONE,
        id: msg.id,
        buffer: msg.buffer,
        error: error instanceof Error ? error.message : String(error),
      },
      [msg.buffer],
    );
  }
}

// FIFO consumer reads (capture-recorder-nodes Phase 0): the recorder/capture
// node asks for a SPECIFIC `wantSeq` via `readSeqInto` (ordered, lossless-
// within-a-ring). Shares the same by-name handle cache + transferred buffer as
// the latest-wins path; only the classification (notYet / gone+oldestSeq /
// closed / frame) differs. The reader addon reuses `buffer` as its dest (C-15),
// so nothing is copied beyond the ring→buffer memcpy inside the addon.
function handlePipeReadSeq(port: MessagePort, msg: PipeReadSeqRequest): void {
  try {
    const handle = pipeHandleFor(msg.shmName);
    const result = reader.readSeqInto(handle, msg.buffer, msg.wantSeq);
    if (isClosed(result)) {
      // Drop the cached handle so a re-advertised pipe re-opens fresh.
      reader.close(handle);
      pipeHandles.delete(msg.shmName);
      port.postMessage(
        { kind: PIPE_READ_SEQ_DONE, id: msg.id, buffer: msg.buffer, closed: true },
        [msg.buffer],
      );
      return;
    }
    if (isNotYet(result)) {
      port.postMessage(
        { kind: PIPE_READ_SEQ_DONE, id: msg.id, buffer: msg.buffer, notYet: true },
        [msg.buffer],
      );
      return;
    }
    if (isGone(result)) {
      port.postMessage(
        {
          kind: PIPE_READ_SEQ_DONE,
          id: msg.id,
          buffer: msg.buffer,
          gone: true,
          oldestSeq: result.oldestSeq,
        },
        [msg.buffer],
      );
      return;
    }
    // `null` (torn read) → no seq: the consumer retries the same wantSeq.
    port.postMessage(
      {
        kind: PIPE_READ_SEQ_DONE,
        id: msg.id,
        buffer: msg.buffer,
        seq: result ? result.seq : undefined,
        tCapture: result ? result.meta?.tCapture : undefined,
        convertMs: result ? result.meta?.convertMs : undefined,
        gen: result ? result.gen : undefined,
        retries: result ? result.retries : undefined,
        width: result ? result.width : undefined,
        height: result ? result.height : undefined,
        originX: result ? result.originX : undefined,
        originY: result ? result.originY : undefined,
        // v5: actual blob length for a compressed pipe (absent on dim-derived).
        bytes: result ? result.bytes : undefined,
      },
      [msg.buffer],
    );
  } catch (error) {
    port.postMessage(
      {
        kind: PIPE_READ_SEQ_DONE,
        id: msg.id,
        buffer: msg.buffer,
        error: error instanceof Error ? error.message : String(error),
      },
      [msg.buffer],
    );
  }
}

function handleReadMessage(port: MessagePort, data: unknown): void {
  const msg = data as
    | ShmReadRequest
    | PipeReadRequest
    | PipeReadSeqRequest
    | undefined;
  if (msg?.kind === PIPE_READ_SEQ) return handlePipeReadSeq(port, msg);
  if (msg?.kind === PIPE_READ) return handlePipeRead(port, msg);
  if (msg?.kind !== SHM_READ) return;
  try {
    const payload = readShmFrame(msg.payload, msg.buffer);
    port.postMessage(
      {
        kind: SHM_READ_DONE,
        id: msg.id,
        payload,
        buffer: payload?.data ?? msg.buffer,
      },
      [payload?.data ?? msg.buffer],
    );
  } catch (error) {
    port.postMessage(
      {
        kind: SHM_READ_DONE,
        id: msg.id,
        payload: null,
        buffer: msg.buffer,
        error: error instanceof Error ? error.message : String(error),
      },
      [msg.buffer],
    );
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data as { kind?: string } | undefined;
  if (msg?.kind !== SHM_INIT) return;
  const port = event.ports[0];
  if (!port) return;
  port.onmessage = (message) => handleReadMessage(port, message.data);
  port.start();
});

installBridge();
