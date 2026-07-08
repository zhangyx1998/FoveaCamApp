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
import {
  createRecordingSink,
  frameVoltageExtras,
  type RecordingSink,
} from "@orchestrator/recorder";
import { matToArray } from "@lib/mat";
import type { Pos } from "@lib/controller-codec";
import type { CalibratedTriple } from "@orchestrator/calibration";

export type { StreamSummary } from "@orchestrator/recorder/legacy";

/** A recorded fovea frame's voltage provenance (WS4 4b):
 *  - `fin`  — bind the FIN's exposure-AVERAGED voltage (B-12) for the exact
 *    capture that produced this frame (`volt.source: "fin-averaged"`);
 *  - `live` — a controller reading at frame arrival (`"live-snapshot"`), the
 *    pre-4b free-run behavior. */
export type FoveaBinding = { A: Point2d; H: Mat<Float64Array> } & (
  | { source: "fin"; frameId: number; volt: Pos }
  | { source: "live"; volt: Pos }
);

export interface RecordingDeps {
  getTriple(): CalibratedTriple | null;
  volts(): { L: Pos; R: Pos };
  /** Optional (WS4 4b): the FIN outcome matched to the frame currently being
   *  recorded on this fovea mirror (by `frame_id`/`t_exposure`), or null when
   *  no triggered capture is bound → the free-run live snapshot is used. Left
   *  unimplemented until the live FIN↔frame pairing lands (Stage F). */
  foveaBinding?(mirror: "L" | "R"): { frameId: number; volt: Pos } | null;
  telemetry(patch: {
    recording_active?: boolean;
    recordingStreams?: Record<
      string,
      { frames: number; dropped: number; fps: number; bytes: number }
    >;
  }): void;
}

/** Resolve a fovea frame's voltage binding (WS4 4b): the FIN's exposure-averaged
 *  voltage when a triggered capture is matched to this frame, else the live
 *  snapshot. `conv` is captured from the recording's triple at `start()` (stays
 *  valid even if the triple is released mid-recording). Pure over `deps`/`conv`. */
export function resolveFoveaBinding(
  deps: RecordingDeps,
  conv: CalibratedTriple["conv"],
  mirror: "L" | "R",
): FoveaBinding {
  const fin = deps.foveaBinding?.(mirror) ?? null;
  const V = fin ? fin.volt : deps.volts()[mirror];
  const A = mirror === "L" ? conv.V2A.L(V) : conv.V2A.R(V);
  const H = mirror === "L" ? conv.A2H.L(A) : conv.A2H.R(A);
  return fin
    ? { source: "fin", frameId: fin.frameId, volt: V, A, H }
    : { source: "live", volt: V, A, H };
}

/** Build a recorded fovea frame's per-frame metadata from its voltage binding.
 *  FIN-bound frames carry the exposure-averaged voltage + `frame_id` via B's
 *  `frameVoltageExtras` (`volt.source: "fin-averaged"`); free-run frames carry
 *  a live snapshot (`"live-snapshot"`). Both add the mirror angle + homography. */
export function buildFoveaMeta(b: FoveaBinding): Record<string, unknown> {
  const volt =
    b.source === "fin"
      ? frameVoltageExtras(b.frameId, b.volt)
      : {
          volt: { x: b.volt.x, y: b.volt.y },
          "volt.unit": "volt",
          "volt.source": "live-snapshot" as const,
        };
  return {
    ...volt,
    angle: { x: b.A.x, y: b.A.y },
    "angle.unit": "radian",
    affine: matToArray(b.H),
  };
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
    deps.telemetry({ recordingStreams: sink?.stats() ?? {} });
  }

  function emitRecFrame(name: string, frame: Frame, fovea?: FoveaBinding): RecordFrame {
    const { raw, raw_format: format } = frame;
    frame.release();
    const meta: Record<string, unknown> = fovea ? buildFoveaMeta(fovea) : {};
    return { name, frame: raw, format, meta };
  }

  async function consume(
    name: string,
    stream: AsyncIterable<Frame>,
    bind?: () => FoveaBinding,
  ): Promise<void> {
    try {
      for await (const frame of stream) {
        if (!active) return;
        const rec = emitRecFrame(name, frame, bind?.());
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
        consume("left-fovea", L.camera.stream, () => resolveFoveaBinding(deps, conv, "L")),
        consume("center", C.camera.stream),
        consume("right-fovea", R.camera.stream, () => resolveFoveaBinding(deps, conv, "R")),
      ];
      deps.telemetry({ recording_active: true, recordingStreams: {} });
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
      deps.telemetry({ recording_active: false, recordingStreams: {} });
      return true;
    },
  };
}
