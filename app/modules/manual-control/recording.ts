// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Server-side recording (capture-recorder-nodes Phase 2, Wave I-2). The
// per-frame consume/copy/transfer that used to run on the orchestrator MAIN JS
// loop (three `lease.camera.stream` taps → bytes → transfer to the mcap worker)
// is GONE: recording now flows entirely through the RECORDER NODE
// (`@orchestrator/recorder-node`) — one worker thread that FIFO-consumes the
// full-bit-depth `camera/<serial>/raw` pipes and hosts the mcap writer
// in-worker. Main only advertises the raw pipes, creates/retires the node, and
// answers the ruling-3 per-frame metadata callback (volt/angle/homography). The
// container contract is UNCHANGED (see recorder/schema.ts).
//
// On finalize we notify main (`recording:finished`) so the viewer window
// auto-opens the finished `.fovea` (rulings 8/9; the receive side lives in
// electron/main.ts).

import { mkdirSync } from "node:fs";
import type { Point2d } from "core/Geometry";
import type { Mat } from "core/Vision";
import { frameVoltageExtras } from "@orchestrator/recorder";
import {
  createRecorderNode,
  type RecorderConnect,
  type RecorderNodeHandle,
  type RecorderStreamStats,
} from "@orchestrator/recorder-node";
import {
  rawPipeSpec,
  DEFAULT_RAW_RING_DEPTH,
  type RawPipeRegistry,
  type RawPipeAcquisition,
} from "@orchestrator/raw-pipe";
import { matToArray } from "@lib/mat";
import type { Pos } from "@lib/controller-codec";
import type { CalibratedTriple } from "@orchestrator/calibration";

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
  /** Refcounted registry for the full-bit-depth `camera/<serial>/raw` pipes
   *  (ONE advertise per id ever; native producer). Injected from index.ts. */
  rawPipes: RawPipeRegistry;
  /** Connect a pipe for the recorder node (refcount++ → C-21 gate → producer
   *  runs); the node releases it on stop. Injected from the session (broker). */
  connect: RecorderConnect;
  /** Notify main a recording finished so the viewer auto-opens it (rulings
   *  8/9). Injected (production: `process.parentPort` post). */
  finished(foveaPath: string): void;
  /** Optional (WS4 4b): the FIN outcome matched to the frame currently being
   *  recorded on this fovea mirror (by `frame_id`/`t_exposure`), or null when
   *  no triggered capture is bound → the free-run live snapshot is used. Left
   *  unimplemented until the live FIN↔frame pairing lands (Stage F). */
  foveaBinding?(mirror: "L" | "R"): { frameId: number; volt: Pos } | null;
  telemetry(patch: {
    recording_active?: boolean;
    recordingStreams?: Record<string, RecorderStreamStats>;
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

/** The three recorded streams → the mirror they carry a fovea binding for
 *  (center has none). Names are the container channel names (unchanged). */
const STREAM_MIRROR: Record<string, "L" | "R" | null> = {
  "left-fovea": "L",
  center: null,
  "right-fovea": "R",
};

export function createRecording(deps: RecordingDeps): RecordingController {
  let active = false;
  let node: RecorderNodeHandle | null = null;
  let acquisitions: RawPipeAcquisition[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function publishStreams(): void {
    deps.telemetry({ recordingStreams: node?.stats() ?? {} });
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

      const { L, C, R } = triple.leases;
      const { conv } = triple;

      // Refcounted acquire (ruling 5): advertise+attach the full-bit-depth raw
      // producers ONCE, shared with any concurrent acquirer (capture) instead of
      // a clobbering second advertise. Consumer-gated: the node's connect below
      // spins them up; deep recorder ring (48).
      const rawFor = (camera: {
        serial: string;
        pixel_format: string;
        getFeatureInt(n: string): number;
      }): RawPipeAcquisition => {
        const pipeId = `camera/${camera.serial}/raw`;
        return deps.rawPipes.acquire({
          kind: "raw",
          camera,
          pipeId,
          spec: rawPipeSpec(camera, pipeId, DEFAULT_RAW_RING_DEPTH),
        });
      };
      // Error-path guard: the acquire refcounts the raw producers, and the
      // native recorder-node build can throw (worker spawn / broker connect).
      // A throw before `active = true` would orphan acquired handles with the
      // controller idle — the deferred cleanup never fires, and a retry
      // double-refcounts (never unadvertises → camera-exclusivity hazard).
      // Release symmetrically with stop() (reverse order, last release retires).
      try {
        acquisitions = [rawFor(L.camera), rawFor(C.camera), rawFor(R.camera)];

        const streams = {
          "left-fovea": { pipeId: acquisitions[0]!.pipeId },
          center: { pipeId: acquisitions[1]!.pipeId },
          "right-fovea": { pipeId: acquisitions[2]!.pipeId },
        };

        node = createRecorderNode({
          id: "recorder/manual-control",
          path,
          streams,
          connect: deps.connect,
          timestamp: new Date().toISOString(),
          // R-2 opt: only the L/R foveae carry a binding — gate the per-frame
          // notice so the center channel skips the pointless main round-trip.
          extrasStreams: ["left-fovea", "right-fovea"],
          // Ruling-3: per NEW frame, the session injects volt/angle/homography for
          // the L/R foveae (center carries none). Never blocks the frame write.
          onFrame: (stream) => {
            const mirror = STREAM_MIRROR[stream];
            if (!mirror) return null;
            return buildFoveaMeta(resolveFoveaBinding(deps, conv, mirror));
          },
        });
      } catch (err) {
        for (const a of [...acquisitions].reverse()) a.release();
        acquisitions = [];
        node = null;
        throw err;
      }

      active = true;
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
      const finished = node;
      // Finalize the container (drains to the producers' latest, writes the mcap
      // summary/index, terminates the worker, disconnects the pipes).
      await node?.stop();
      node = null;
      // Release the raw acquisitions AFTER the node released its connections
      // (last release retires the producer + unadvertises).
      for (const p of acquisitions) p.release();
      acquisitions = [];
      deps.telemetry({ recording_active: false, recordingStreams: {} });
      // Auto-open the finished recording in the viewer window (rulings 8/9).
      if (finished) deps.finished(finished.filePath);
      return true;
    },
  };
}
