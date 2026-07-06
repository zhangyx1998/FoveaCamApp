// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { createRequire } from "node:module";
import path from "node:path";
import { contextBridge, ipcRenderer } from "electron";
import type { FoveaBridge } from "./bridge";
import type { FramePayload } from "@lib/orchestrator/protocol";

// ⚠ KEEP SELF-CONTAINED (V11): sandboxed preloads cannot require sibling
// chunks, so this entry must share zero runtime modules with `preload.ts` —
// otherwise rollup splits the shared module into a chunk and the *sandboxed*
// windows (profiler; main with FOVEA_SHM_STREAMS off) fail to load their
// preload at all. The bridge below is a hand-synced copy of `preload.ts`'s.
function installBridge(extra: Partial<FoveaBridge> = {}) {
  ipcRenderer.on("orchestrator:port", (e) => {
    window.postMessage("orchestrator:port", "*", e.ports);
  });

  const bridge: FoveaBridge = {
    connectOrchestrator: () => ipcRenderer.send("orchestrator:connect"),
    onOrchestratorDown: (cb) => {
      ipcRenderer.on("orchestrator:down", () => cb());
    },
    openProfilerWindow: () => ipcRenderer.send("open-profiler-window"),
    resolvePath: (...segments) => ipcRenderer.invoke("save-path:resolve", segments),
    resolveDefaultSavePath: (directory) =>
      ipcRenderer.invoke("save-path:resolve-default", directory),
    pathExists: (path) => ipcRenderer.invoke("fs:exists", path),
    validateWritablePath: (path) => ipcRenderer.invoke("fs:validate-writable", path),
    writePerfSnapshot: (content) => ipcRenderer.invoke("perf-snapshot:write", content),
    ...extra,
  };

  contextBridge.exposeInMainWorld("foveaBridge", bridge);
}

type ReaderHandle = object;
type ReaderAddon = {
  open(seg: string): ReaderHandle;
  readInto(
    handle: ReaderHandle,
    dest: ArrayBuffer,
    lastSeq: bigint,
  ): { seq: bigint; gen: number; retries: number; meta?: FramePayload["meta"] } | null;
  close(handle: ReaderHandle): void;
};

const require = createRequire(import.meta.url);
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

function byteLength(payload: FramePayload): number {
  return payload.shape.reduce((p, n) => p * n, payload.channels);
}

function handleFor(seg: string, gen: number): ReaderHandle {
  const cached = handles.get(seg);
  if (cached?.gen === gen) return cached.handle;
  if (cached) reader.close(cached.handle);
  const handle = reader.open(seg);
  handles.set(seg, { gen, handle });
  return handle;
}

installBridge({
  async readShmFrame(payload) {
    return readShmFrame(payload, new ArrayBuffer(byteLength(payload)));
  },
});

function readShmFrame(payload: FramePayload, dest: ArrayBuffer): FramePayload | null {
  if (!payload.shm) return null;
  const handle = handleFor(payload.shm.seg, payload.shm.gen);
  const lastSeq = payload.shm.seq > 0n ? payload.shm.seq - 1n : 0n;
  const result = reader.readInto(handle, dest, lastSeq);
  if (!result) return null;
  return {
    data: dest,
    shape: payload.shape,
    channels: payload.channels,
    meta: { ...payload.meta, ...result.meta },
    shm: {
      ...payload.shm,
      gen: result.gen,
      seq: result.seq,
      retries: result.retries,
      transfer: "port",
    },
  };
}

function handleReadMessage(port: MessagePort, data: unknown): void {
  const msg = data as
    | { kind: "fovea:shm:read"; id: number; payload: FramePayload; buffer: ArrayBuffer }
    | undefined;
  if (msg?.kind !== "fovea:shm:read") return;
  try {
    const payload = readShmFrame(msg.payload, msg.buffer);
    port.postMessage(
      {
        kind: "fovea:shm:read-done",
        id: msg.id,
        payload,
        buffer: payload?.data ?? msg.buffer,
      },
      [payload?.data ?? msg.buffer],
    );
  } catch (error) {
    port.postMessage(
      {
        kind: "fovea:shm:read-done",
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
  if (msg?.kind !== "fovea:shm:init") return;
  const port = event.ports[0];
  if (!port) return;
  port.onmessage = (message) => handleReadMessage(port, message.data);
  port.start();
});
