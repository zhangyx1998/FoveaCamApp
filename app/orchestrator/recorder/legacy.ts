// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Legacy `.stream`/`.meta`/manifest recording backend — the fallback behind
// `RECORDER_BACKEND` in `index.ts`. This is the exact behavior that lived in
// `modules/manual-control/recording.ts` before B-5 (per-stream StreamWriter,
// `manifest.json` rewritten at start / on new stream / at stop-with-duration,
// `__init__.py` + `play` decoder scaffolding), moved behind the shared
// `RecordingSink` facade so the manual-control session is format-agnostic.
// On-disk output is byte-identical to the pre-B-5 path — external decoder
// tooling depends on it.

import { chmodSync } from "node:fs";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import type { PixelFormat } from "core/Aravis";
import type { Mat } from "core/Vision";
import StreamWriter from "../stream-writer.js";
import PythonScript from "../stream-decoder.py?raw";
import type { RecordingSink } from "./index.js";
import type { StreamStats } from "./types.js";

export interface StreamSummary {
  frames: number;
  dropped: number;
  bytes: number;
}

interface Manifest {
  format: string;
  version: string;
  timestamp: string | null;
  duration: number | null;
  streams?: Record<string, StreamSummary>;
}

export async function createLegacySink(
  basePath: string,
  timestamp: string,
): Promise<RecordingSink> {
  await fs.writeFile(resolve(basePath, "__init__.py"), PythonScript, "utf8");
  const playScript = '#!/bin/bash\ncd "$(dirname "$0")"\npython3 __init__.py "$@"\n';
  await fs.writeFile(resolve(basePath, "play"), playScript, "utf8");
  chmodSync(resolve(basePath, "play"), 0o755);

  const writers = new Map<string, StreamWriter>();

  function writeManifest(duration?: number): Promise<void> {
    const streams: Record<string, StreamSummary> = Object.fromEntries(
      [...writers.entries()].map(([name, writer]) => [name, writer.summary]),
    );
    const manifest: Manifest = {
      format: "FCRS", // FoveaCam Recording Stream
      version: "0.0.0-alpha.0",
      timestamp,
      duration: duration ?? null,
      streams,
    };
    return fs.writeFile(
      resolve(basePath, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  function getWriter(name: string): StreamWriter {
    let writer = writers.get(name);
    if (!writer) {
      writer = new StreamWriter(basePath, name);
      writers.set(name, writer);
      void writeManifest();
    }
    return writer;
  }

  await writeManifest();

  return {
    kind: "legacy",

    write(
      stream: string,
      frame: Mat,
      format: PixelFormat,
      timestampSec?: number,
      extra?: Record<string, unknown>,
    ): void {
      getWriter(stream).write(frame, format, timestampSec, extra);
    },

    stats(): Record<string, StreamStats> {
      const out: Record<string, StreamStats> = {};
      for (const [name, writer] of writers)
        out[name] = {
          frames: writer.frameCount,
          dropped: writer.dropped,
          fps: writer.fps.value,
          bytes: writer.summary.bytes,
        };
      return out;
    },

    async finalize(durationSec: number): Promise<void> {
      await Promise.all([...writers.values()].map((w) => w.flush()));
      await writeManifest(durationSec);
    },
  };
}
