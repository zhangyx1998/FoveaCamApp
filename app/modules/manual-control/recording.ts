// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Server-side recording, ported from `src/record/index.ts`'s `Recording`
// class + manual-control's `emitRecFrame`/three `recording.provide` raw
// stream consumers (docs/refactor/orchestrator.md roadmap item 6). Three
// independent raw consumers of `leases.L/C/R.camera.stream` (safe alongside
// the registry's own preview loop and a concurrent capture pass — see
// `capture.ts`'s header) write directly to disk via the relocated
// `StreamWriter`; L/R frames carry a volt/angle/homography metadata snapshot
// taken at arrival, matching the original `emitRecFrame`. On-disk format
// (`.stream`/`.meta`/`manifest.json`/`__init__.py`/`play`) is unchanged —
// external decoder tooling depends on it.

import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import type { Frame, PixelFormat } from "core/Aravis";
import type { Point2d } from "core/Geometry";
import type { Mat } from "core/Vision";
import StreamWriter from "@orchestrator/stream-writer";
import PythonScript from "@orchestrator/stream-decoder.py?raw";
import { matToArray } from "@lib/mat";
import type { Pos } from "@lib/controller-codec";
import type { CalibratedTriple } from "@orchestrator/calibration";

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

export interface RecordingDeps {
  getTriple(): CalibratedTriple | null;
  volts(): { L: Pos; R: Pos };
  telemetry(patch: {
    recording_active?: boolean;
    recording_streams?: Record<
      string,
      { frames: number; dropped: number; fps: number; bytes: number }
    >;
  }): void;
}

export interface RecordingController {
  start(path: string): Promise<boolean>;
  stop(): Promise<boolean>;
}

type RecordFrame = {
  name: string;
  frame: Mat;
  format: PixelFormat;
  meta?: Record<string, unknown>;
};

export function createRecording(deps: RecordingDeps): RecordingController {
  let active = false;
  let sessionPath: string | null = null;
  let timestamp: string | null = null;
  let t0 = 0;
  let writers = new Map<string, StreamWriter>();
  let tasks: Promise<void>[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function getWriter(name: string): StreamWriter {
    let writer = writers.get(name);
    if (!writer) {
      writer = new StreamWriter(sessionPath!, name);
      writers.set(name, writer);
      void writeManifest(sessionPath!);
    }
    return writer;
  }

  function writeManifest(path: string, duration?: number): Promise<void> {
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
    return fs.writeFile(resolve(path, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  function publishStreams(): void {
    const streams: Record<string, { frames: number; dropped: number; fps: number; bytes: number }> = {};
    for (const [name, writer] of writers)
      streams[name] = {
        frames: writer.frameCount,
        dropped: writer.dropped,
        fps: writer.fps.value,
        bytes: writer.summary.bytes,
      };
    deps.telemetry({ recording_streams: streams });
  }

  function emitRecFrame(
    name: string,
    frame: Frame,
    fovea?: { V: Pos; A: Point2d; H: Mat<Float64Array> },
  ): RecordFrame {
    const { raw, raw_format: format } = frame;
    frame.release();
    const meta: Record<string, unknown> = {};
    if (fovea)
      Object.assign(meta, {
        volt: { ...fovea.V },
        "volt.unit": "volt",
        angle: { ...fovea.A },
        "angle.unit": "radian",
        affine: matToArray(fovea.H),
      });
    return { name, frame: raw, format, meta };
  }

  async function consume(name: string, stream: AsyncIterable<Frame>, buildMeta?: () => { V: Pos; A: Point2d; H: Mat<Float64Array> }): Promise<void> {
    try {
      for await (const frame of stream) {
        if (!active) return;
        const rec = emitRecFrame(name, frame, buildMeta?.());
        getWriter(rec.name).write(rec.frame, rec.format, undefined, rec.meta);
      }
    } catch (e) {
      console.error(`[manual-control] recording stream "${name}":`, e);
    }
  }

  return {
    async start(path) {
      if (active) return false;
      path = path.trim();
      if (path === "") return false;
      const triple = deps.getTriple();
      if (!triple) return false;
      mkdirSync(path, { recursive: true });
      await fs.writeFile(resolve(path, "__init__.py"), PythonScript, "utf8");
      const playScript = '#!/bin/bash\ncd "$(dirname "$0")"\npython3 __init__.py "$@"\n';
      await fs.writeFile(resolve(path, "play"), playScript, "utf8");
      chmodSync(resolve(path, "play"), 0o755);
      sessionPath = path;
      timestamp = new Date().toISOString();
      t0 = performance.now();
      writers = new Map();
      active = true;
      await writeManifest(path);
      const { L, C, R } = triple.leases;
      const { conv } = triple;
      tasks = [
        consume("left-fovea", L.camera.stream, () => {
          const V = deps.volts().L;
          const A = conv.V2A.L(V);
          return { V, A, H: conv.A2H.L(A) };
        }),
        consume("center", C.camera.stream),
        consume("right-fovea", R.camera.stream, () => {
          const V = deps.volts().R;
          const A = conv.V2A.R(V);
          return { V, A, H: conv.A2H.R(A) };
        }),
      ];
      deps.telemetry({ recording_active: true, recording_streams: {} });
      pollTimer = setInterval(publishStreams, 250);
      return true;
    },

    async stop() {
      if (!active) return false;
      const path = sessionPath;
      active = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      await Promise.allSettled(tasks);
      tasks = [];
      await Promise.all([...writers.values()].map((w) => w.flush()));
      const duration = (performance.now() - t0) / 1000;
      if (path) await writeManifest(path, duration);
      writers = new Map();
      sessionPath = null;
      deps.telemetry({ recording_active: false, recording_streams: {} });
      return true;
    },
  };
}
