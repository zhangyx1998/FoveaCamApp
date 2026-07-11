// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Server-side recording — thin config over the shared
// `@orchestrator/recording-service`: the L/C/R fovea streams (full-bit-depth
// `camera/<serial>/raw` pipes) + the ruling-3 fovea-binding `onFrame`. Recording
// flows through the RECORDER NODE (its own worker thread); main only advertises,
// creates/retires, and answers per-frame metadata. Behavior spec:
// docs/spec/manual-control.md §capture.

import type { Point2d } from "core/Geometry";
import type { Mat } from "core/Vision";
import { frameVoltageExtras } from "@orchestrator/recorder";
import {
  type RecorderConnect,
  type RecorderStreamStats,
} from "@orchestrator/recorder-node";
import {
  createRecordingService,
  type RecordingAcquisition,
} from "@orchestrator/recording-service";
import {
  rawPipeSpec,
  DEFAULT_RAW_RING_DEPTH,
  type RawPipeRegistry,
  type RawPipeAcquisition,
} from "@orchestrator/raw-pipe";
import { matToArray } from "@lib/mat";
import type { Pos } from "@lib/controller-codec";
import type { CalibratedTriple } from "@orchestrator/calibration";

/** A recorded fovea frame's voltage provenance (spec §capture): `fin` = the
 *  FIN's exposure-averaged voltage (`fin-averaged`), `live` = a controller
 *  reading at frame arrival (`live-snapshot`, the free-run default). */
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
  /** The FIN outcome matched to the frame being recorded on this fovea mirror,
   *  else null → free-run live snapshot (spec §capture). Stage-F-gated. */
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
  // Thin config over the shared facility (spec §capture): the L/C/R streams +
  // the fovea-binding `onFrame`; the facility owns start/stop/poll/telemetry.
  const service = createRecordingService({
    id: "recorder/manual-control",
    ready: () => deps.getTriple() !== null,
    telemetry: deps.telemetry,
    finished: deps.finished,
    acquire(): RecordingAcquisition {
      const triple = deps.getTriple()!; // `ready()` guaranteed non-null
      const { L, C, R } = triple.leases;
      const { conv } = triple;

      // Refcounted acquire (spec §capture): advertise+attach the raw producers
      // ONCE, shared with any concurrent acquirer instead of clobbering.
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
      const acquisitions = [rawFor(L.camera), rawFor(C.camera), rawFor(R.camera)];

      const streams = {
        "left-fovea": { pipeId: acquisitions[0]!.pipeId },
        center: { pipeId: acquisitions[1]!.pipeId },
        "right-fovea": { pipeId: acquisitions[2]!.pipeId },
      };

      return {
        nodeOptions: {
          streams,
          connect: deps.connect,
          // R-2 opt: only the L/R foveae carry a binding — gate the per-frame
          // notice so the center channel skips the pointless main round-trip.
          extrasStreams: ["left-fovea", "right-fovea"],
          // Ruling-3: per NEW frame, the session injects volt/angle/homography
          // for the L/R foveae (center carries none). Never blocks the write.
          onFrame: (stream) => {
            const mirror = STREAM_MIRROR[stream];
            if (!mirror) return null;
            return buildFoveaMeta(resolveFoveaBinding(deps, conv, mirror));
          },
        },
        release: () => {
          for (const a of [...acquisitions].reverse()) a.release();
        },
      };
    },
  });

  return {
    get active() {
      return service.active;
    },
    start: (path) => service.start(path),
    stop: () => service.stop(),
  };
}
