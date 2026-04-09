// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { mkdirSync, createWriteStream, WriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createGzip, Gzip } from "node:zlib";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { onScopeDispose, ref, shallowRef, type Ref } from "vue";
import type { Mat } from "core/Vision";
import { ipcRenderer } from "electron";

function getDateTimeString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export type RecordResource = {
  image?: Mat | null;
  meta?: unknown;
  timestamp?: bigint | number | string | null;
};

type FrameSummary = {
  frame: number;
  timestamp: string | number;
  captured_at_ns: string;
  byte_offset: number;
  byte_length: number;
  shape: number[];
  channels: number;
  dtype: string;
  dropped_before: number;
  meta?: unknown;
};

type Packet = {
  payload: Buffer;
  summary: FrameSummary;
};

function bufferFromMat(image: Mat) {
  const bytes = new Uint8Array(image.buffer, image.byteOffset, image.byteLength);
  return Buffer.from(bytes);
}

function matTypeName(image: Mat) {
  return image.constructor?.name ?? "TypedArray";
}

function normalizeTimestamp(
  ts: RecordResource["timestamp"],
): string | number | null {
  if (typeof ts === "bigint") return ts.toString();
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") return ts;
  return null;
}

function epochNowNs() {
  return BigInt(Date.now()) * 1_000_000n;
}

function waitForEvent<T>(
  emitter: NodeJS.EventEmitter,
  event: string,
  error = "error",
) {
  return new Promise<T>((resolve, reject) => {
    const onData = (value: T) => {
      cleanup();
      resolve(value);
    };
    const onError = (e: unknown) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      emitter.off(event, onData);
      emitter.off(error, onError);
    };
    emitter.once(event, onData);
    emitter.once(error, onError);
  });
}

class StreamWriter {
  // 180 frames ~= 1 second of buffering for 3 streams at 60 FPS each, which
  // keeps memory bounded while giving disk I/O short bursts to catch up.
  private static readonly MAX_QUEUE = 180;
  // Small polling interval used only during shutdown while waiting for queue drain.
  private static readonly CLOSE_WAIT_MS = 5;
  private readonly gzip: Gzip;
  private readonly output: WriteStream;
  private readonly index: WriteStream;
  private readonly queue: Packet[] = [];
  private draining = false;
  private closed = false;
  private frameCount = 0;
  private dropped = 0;
  private byteOffset = 0;
  readonly framesFile: string;
  readonly indexFile: string;

  constructor(
    private readonly path: string,
    private readonly name: string,
  ) {
    this.framesFile = `${name}.frames.bin.gz`;
    this.indexFile = `${name}.index.jsonl`;
    this.gzip = createGzip({ level: 1 });
    this.output = createWriteStream(resolve(path, this.framesFile));
    this.index = createWriteStream(resolve(path, this.indexFile), {
      encoding: "utf8",
    });
    this.gzip.pipe(this.output);
  }

  get summary() {
    return {
      frames: this.frameCount,
      dropped: this.dropped,
      bytes_uncompressed: this.byteOffset,
      frames_file: this.framesFile,
      index_file: this.indexFile,
    };
  }

  enqueue(packet: Packet) {
    if (this.closed) return;
    if (this.queue.length >= StreamWriter.MAX_QUEUE) {
      this.dropped++;
      return;
    }
    this.queue.push(packet);
    if (!this.draining) void this.drain();
  }

  private async drain() {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const packet = this.queue.shift()!;
        packet.summary.dropped_before = this.dropped;
        this.dropped = 0;
        packet.summary.frame = this.frameCount++;
        packet.summary.byte_offset = this.byteOffset;
        packet.summary.byte_length = packet.payload.byteLength;
        this.byteOffset += packet.payload.byteLength;
        if (!this.index.write(JSON.stringify(packet.summary) + "\n"))
          await waitForEvent(this.index, "drain");
        if (!this.gzip.write(packet.payload)) await waitForEvent(this.gzip, "drain");
      }
    } finally {
      this.draining = false;
    }
  }

  async close() {
    this.closed = true;
    while (this.draining || this.queue.length > 0) {
      if (!this.draining) void this.drain();
      await new Promise((r) => setTimeout(r, StreamWriter.CLOSE_WAIT_MS));
    }
    const outputDone = waitForEvent<void>(this.output, "finish");
    const indexDone = waitForEvent<void>(this.index, "finish");
    this.index.end();
    this.gzip.end();
    await Promise.all([outputDone, indexDone]);
  }
}

export const current_recording = shallowRef<Recording | null>(null);

export async function promptRecordingPath(defaultPath: string) {
  try {
    const selected = await ipcRenderer.invoke("prompt-recording-path", defaultPath);
    if (!selected || typeof selected !== "string") return null;
    return selected.trim() || null;
  } catch {
    return null;
  }
}

export default class Recording {
  readonly run_id = getDateTimeString();
  get directory() {
    return `${this.run_id}-${this.namespace}`;
  }

  private readonly __last_save_path = ref<string | null>(null);
  get default_path() {
    return resolve(homedir(), "Downloads", this.directory);
  }
  get current_path() {
    return this.__last_save_path.value ?? this.default_path;
  }
  set current_path(path: string) {
    path = path.trim();
    this.__last_save_path.value = path === "" || path === this.default_path ? null : path;
  }

  readonly active: Ref<boolean> = ref(false);
  readonly session_path: Ref<string | null> = ref(null);
  private readonly started_at = ref<string | null>(null);
  private writers = new Map<string, StreamWriter>();

  constructor(public readonly namespace: string) {
    if (current_recording.value !== null)
      throw new Error(
        `A recording context is already active for "${current_recording.value.namespace}".`,
      );
    current_recording.value = this;
    onScopeDispose(() => this.dispose());
  }

  dispose() {
    void this.stop();
    if (current_recording.value === this) current_recording.value = null;
  }

  private makePacket(data: RecordResource): Packet | null {
    const image = data.image;
    if (!image) return null;
    const timestamp = normalizeTimestamp(data.timestamp);
    const captured_at_ns = epochNowNs();
    const packet: Packet = {
      payload: bufferFromMat(image),
      summary: {
        frame: 0,
        timestamp: timestamp ?? captured_at_ns.toString(),
        captured_at_ns: captured_at_ns.toString(),
        byte_offset: 0,
        byte_length: 0,
        shape: [...image.shape],
        channels: image.channels,
        dtype: matTypeName(image),
        dropped_before: 0,
      },
    };
    if (data.meta !== undefined) packet.summary.meta = data.meta;
    return packet;
  }

  private writeManifest(path: string, finished_at?: string) {
    const streams = Object.fromEntries(
      [...this.writers.entries()].map(([name, writer]) => [name, writer.summary]),
    );
    const manifest = {
      version: 1,
      format: "foveacam-recording-v1",
      namespace: this.namespace,
      run_id: this.run_id,
      started_at: this.started_at.value,
      finished_at: finished_at ?? null,
      streams,
    };
    return fs.writeFile(
      resolve(path, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  async start(path: string) {
    if (this.active.value) return false;
    path = path.trim();
    if (path === "") return false;
    mkdirSync(path, { recursive: true });
    this.current_path = path;
    this.session_path.value = path;
    this.started_at.value = new Date().toISOString();
    this.writers = new Map();
    this.active.value = true;
    await this.writeManifest(path);
    return true;
  }

  append(name: string, data: RecordResource) {
    if (!this.active.value) return false;
    const path = this.session_path.value;
    if (!path) return false;
    const packet = this.makePacket(data);
    if (!packet) return false;
    let writer = this.writers.get(name);
    if (!writer) {
      writer = new StreamWriter(path, name);
      this.writers.set(name, writer);
      void this.writeManifest(path);
    }
    writer.enqueue(packet);
    return true;
  }

  async stop() {
    if (!this.active.value) return false;
    const path = this.session_path.value;
    this.active.value = false;
    const writers = [...this.writers.values()];
    await Promise.all(writers.map((w) => w.close()));
    if (path) await this.writeManifest(path, new Date().toISOString());
    this.writers = new Map();
    this.session_path.value = null;
    return true;
  }
}
