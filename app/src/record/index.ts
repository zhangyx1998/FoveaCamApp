// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { mkdirSync, chmodSync } from "node:fs";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { onScopeDispose, reactive, ref, shallowRef, type Ref } from "vue";
import type { Mat } from "core/Vision";
import type { PixelFormat } from "core/Aravis";
import { SavePath } from "@lib/save-path";
import StreamWriter from "./stream";
import PythonScript from "./stream-decoder.py?raw";

export type { FrameMeta } from "./stream";

export interface StreamSummary {
  frames: number;
  dropped: number;
  bytes: number;
}

export interface Manifest<X = {}> {
  /** Format Identifier */
  format: string;
  /** Semantic Versioning */
  version: string;
  /** ISO 8601 */
  timestamp: string | null;
  /** Duation in Seconds */
  duration: number | null;
  /** Optional summary of each stream. */
  streams?: Record<string, StreamSummary>;
  /** Optional extension field for custom metadata. */
  extension?: X;
}

export type RecordFrame = {
  name: string;
  frame: Mat;
  format: PixelFormat;
  /** Optional timestamp in seconds, default to performance.now() */
  timestamp?: number;
  meta?: Record<string, unknown>;
};

export type StreamFactory = (
  live: () => boolean,
) => AsyncGenerator<RecordFrame>;

export type StreamInfo = {
  frames: number;
  dropped: number;
  fps: number;
  bytes: number;
};

export const current_recording = shallowRef<Recording | null>(null);

export default class Recording extends SavePath {
  readonly active: Ref<boolean> = ref(false);
  readonly session_path: Ref<string | null> = ref(null);
  readonly streams = reactive(new Map<string, StreamInfo>());
  private readonly timestamp = ref<string | null>(null);
  private t0: number = 0;
  private writers = new Map<string, StreamWriter>();
  private providers = new Set<StreamFactory>();
  private tasks: Promise<void>[] = [];

  constructor(
    namespace: string,
    private readonly manifestExtension?: Manifest["extension"],
  ) {
    super(namespace);
    if (current_recording.value !== null)
      throw new Error(
        `A recording context is already active for "${current_recording.value.namespace}".`,
      );
    current_recording.value = this;
    onScopeDispose(() => this.dispose());
  }

  dispose() {
    this.stop();
    if (current_recording.value === this) current_recording.value = null;
  }

  provide(factory: StreamFactory) {
    this.providers.add(factory);
    const revoke = () => this.providers.delete(factory);
    onScopeDispose(revoke);
    return revoke;
  }

  private getWriter(name: string): StreamWriter {
    let writer = this.writers.get(name);
    if (!writer) {
      writer = new StreamWriter(this.session_path.value!, name);
      this.writers.set(name, writer);
      this.streams.set(name, { frames: 0, dropped: 0, fps: 0, bytes: 0 });
      void this.writeManifest(this.session_path.value!);
    }
    return writer;
  }

  private writeManifest(path: string, duration?: number) {
    const streams: Record<string, StreamSummary> = Object.fromEntries(
      [...this.writers.entries()].map(([name, writer]) => [
        name,
        writer.summary,
      ]),
    );
    const manifest: Manifest = {
      format: "FCRS", // FoveaCam Recording Stream
      version: "0.0.0-alpha.0",
      timestamp: this.timestamp.value,
      duration: duration ?? null,
      streams,
      extension: this.manifestExtension,
    };
    return fs.writeFile(
      resolve(path, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  private async consumeProvider(factory: StreamFactory) {
    const gen = factory(() => this.active.value);
    try {
      for await (const data of gen) {
        if (!this.active.value) break;
        const writer = this.getWriter(data.name);
        writer.write(data.frame, data.format, data.timestamp, data.meta);
        this.streams.set(data.name, {
          frames: writer.frameCount,
          dropped: writer.dropped,
          fps: writer.fps.value,
          bytes: writer.summary.bytes,
        });
      }
    } catch (e) {
      console.error(`Recording provider error:`, e);
    }
  }

  async start(path: string) {
    if (this.active.value) return false;
    path = path.trim();
    if (path === "") return false;
    mkdirSync(path, { recursive: true });
    await fs.writeFile(resolve(path, "__init__.py"), PythonScript, "utf8");
    const playScript =
      '#!/bin/bash\ncd "$(dirname "$0")"\npython3 __init__.py "$@"\n';
    await fs.writeFile(resolve(path, "play"), playScript, "utf8");
    chmodSync(resolve(path, "play"), 0o755);
    this.current_path = path;
    this.session_path.value = path;
    this.timestamp.value = new Date().toISOString();
    this.t0 = performance.now();
    this.writers = new Map();
    this.streams.clear();
    this.active.value = true;
    await this.writeManifest(path);
    this.tasks = [...this.providers].map((factory) =>
      this.consumeProvider(factory),
    );
    return true;
  }

  async stop() {
    if (!this.active.value) return false;
    const path = this.session_path.value;
    this.active.value = false;
    await Promise.allSettled(this.tasks);
    this.tasks = [];
    await Promise.all([...this.writers.values()].map((w) => w.flush()));
    const duration = (performance.now() - this.t0) / 1000;
    if (path) await this.writeManifest(path, duration);
    this.writers = new Map();
    this.streams.clear();
    this.session_path.value = null;
    return true;
  }
}
