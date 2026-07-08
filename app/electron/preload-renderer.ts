// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Main-window preload: the shared bridge + the shm frame reader. The shm
// path is canonical for transport previews, so this window always runs
// `sandbox: false` (required to load the native reader addon; the profiler
// window stays sandboxed with `preload-profiler.ts`). Bundled self-contained
// by its own build pass (see preload-bridge.ts header / V11).
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
  SHM_INIT,
  SHM_READ,
  SHM_READ_DONE,
  type PipeReadRequest,
  type ShmReadRequest,
} from "@lib/orchestrator/shm-messages";

type ReaderHandle = object;
/** A closed pipe read (C-17): explicit signal, distinct from `null` (no new
 *  frame) — the reader addon returns this once the publisher sets state=CLOSED. */
type ReaderClosed = { closed: true };
type ReaderAddon = {
  open(seg: string): ReaderHandle;
  readInto(
    handle: ReaderHandle,
    dest: ArrayBuffer,
    lastSeq: bigint,
  ): ShmReadResult | ReaderClosed | null;
  close(handle: ReaderHandle): void;
};

const isClosed = (r: unknown): r is ReaderClosed =>
  typeof r === "object" && r !== null && (r as ReaderClosed).closed === true;

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
        width: result ? result.width : undefined,
        height: result ? result.height : undefined,
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

function handleReadMessage(port: MessagePort, data: unknown): void {
  const msg = data as ShmReadRequest | PipeReadRequest | undefined;
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
