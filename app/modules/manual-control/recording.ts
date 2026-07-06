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
// `capture.ts`'s header) write to disk through the format-agnostic
// `RecordingSink` facade (B-5, docs/refactor/recorder-container.md): the
// `RECORDER_BACKEND` constant in `@orchestrator/recorder` selects the new
// single-file `.fovea` (MCAP) container or the legacy `.stream`/`.meta`/
// manifest dump (unchanged on disk — external decoder tooling depends on
// it). L/R frames carry a volt/angle/homography metadata snapshot taken at
// arrival, matching the original `emitRecFrame`, on either backend.

import { mkdirSync } from "node:fs";
import type { Frame, PixelFormat } from "core/Aravis";
import type { Point2d } from "core/Geometry";
import type { Mat } from "core/Vision";
import { createRecordingSink, type RecordingSink } from "@orchestrator/recorder";
import { matToArray } from "@lib/mat";
import type { Pos } from "@lib/controller-codec";
import type { CalibratedTriple } from "@orchestrator/calibration";

export type { StreamSummary } from "@orchestrator/recorder/legacy";

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
  /** True while a recording is running (drain-refusal probe — the
   *  multi-window switch path must not force-drain mid-recording). */
  readonly active: boolean;
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
  let sink: RecordingSink | null = null;
  let t0 = 0;
  let tasks: Promise<void>[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function publishStreams(): void {
    deps.telemetry({ recording_streams: sink?.stats() ?? {} });
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
        sink?.write(rec.name, rec.frame, rec.format, undefined, rec.meta);
      }
    } catch (e) {
      console.error(`[manual-control] recording stream "${name}":`, e);
    }
  }

  return {
    get active() {
      return active;
    },

    async start(path) {
      if (active) return false;
      path = path.trim();
      if (path === "") return false;
      const triple = deps.getTriple();
      if (!triple) return false;
      mkdirSync(path, { recursive: true });
      t0 = performance.now();
      sink = await createRecordingSink(path, new Date().toISOString());
      active = true;
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
      active = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      await Promise.allSettled(tasks);
      tasks = [];
      const duration = (performance.now() - t0) / 1000;
      await sink?.finalize(duration);
      sink = null;
      deps.telemetry({ recording_active: false, recording_streams: {} });
      return true;
    },
  };
}
