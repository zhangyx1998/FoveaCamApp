// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared "record the app's raw camera streams" config over the recording
// facility (capture-recorder-everywhere ruling 2). Most apps that gain
// recording (disparity-scope + the four calibrate wizards) have no per-frame
// fovea binding to inject — they just want the OBVIOUS default recordable set:
// the full-bit-depth `camera/<serial>/raw` sensor stream(s) the app's cameras
// produce, advert-verbatim. This helper wraps that case so each app opts in with
// a `cameras()` accessor and a `finished` notifier instead of re-deriving the
// raw-pipe acquire + connect + error-unwind config.
//
// It reuses manual-control's exact raw-pipe acquire (the UNPACKED 16-bit
// container, deep recorder ring) + the ruling-8 significantBits connect
// injection. No `onFrame`: these recordings carry no per-frame extras (the app
// holds no controller pose bound to the frame) — the container is the raw
// sensor stream only, honest and reconstructable.

import {
  createRecordingService,
  type RecordingService,
} from "@orchestrator/recording-service";
import type { RecorderConnect, RecorderStreamStats } from "@orchestrator/recorder-node";
import type { PipeBroker } from "@orchestrator/pipe-session";
import {
  rawPipeSpec,
  DEFAULT_RAW_RING_DEPTH,
  type RawPipeRegistry,
  type RawPipeAcquisition,
} from "@orchestrator/raw-pipe";
import {
  createCompressPipe,
  type CompressPipeSeam,
  type CompressHandle,
} from "@orchestrator/compress-pipe";
import {
  readRecordCompression,
  type RecordCompression,
} from "@orchestrator/record-compression";

/** A camera the recording taps: the native handle + the geometry the raw spec
 *  needs (serial / pixel_format / dims). Matches the leased `camera` object. */
export interface RawRecordingCamera {
  serial: string;
  pixel_format: string;
  getFeatureInt(n: string): number;
}

export interface RawRecordingDeps {
  /** Graph node id — `recorder/<session>`. */
  id: string;
  /** Broker for the recorder-node pipe connects (refcount++ → C-21 gate). */
  broker: PipeBroker;
  /** Refcounted raw-pipe registry (ONE advertise per id ever; shared process
   *  wide with any concurrent acquirer — capture / another app's recording). */
  rawPipes: RawPipeRegistry;
  /** The default recordable streams (channel name → leased camera), or null when
   *  the session is not active. The map ORDER is the container channel order. */
  streams(): Record<string, RawRecordingCamera> | null;
  /** Notify main a recording finished so the viewer window auto-opens it. */
  finished(foveaPath: string): void;
  /** Publish the recording telemetry patch (session `s.telemetry`). */
  telemetry(patch: {
    recording_active?: boolean;
    recordingStreams?: Record<string, RecorderStreamStats>;
  }): void;
  /** The zlib CompressStream brick seam (injected from index.ts, process-wide
   *  singleton). Absent → the `"zlib"` method degrades to raw (no brick) — a
   *  vitest without native core records uncompressed. */
  compress?: CompressPipeSeam;
  /** Test seam: read the configured compression method at RECORDING START
   *  (default: `readRecordCompression()` over the store-hub `["config"]` doc). */
  readMethod?: () => Promise<RecordCompression>;
  /** Test seam: recorder node factory (default: the real one). */
  createNode?: RecordingServiceConfigCreateNode;
}

/** Local alias so callers need not import the facility's option type. */
type RecordingServiceConfigCreateNode = NonNullable<
  Parameters<typeof createRecordingService>[0]["createNode"]
>;

/** Build a recording controller that writes the app's raw camera streams. */
export function createRawRecording(deps: RawRecordingDeps): RecordingService {
  const readMethod = deps.readMethod ?? readRecordCompression;
  // The configured compression method, read at RECORDING START (`prepare`) so
  // `acquire` (synchronous) sees a fresh value. Applies to NEW recordings; a
  // running recording keeps the method it started with.
  let method: RecordCompression = "none";

  return createRecordingService({
    id: deps.id,
    createNode: deps.createNode,
    ready: () => deps.streams() !== null,
    telemetry: deps.telemetry,
    finished: deps.finished,
    async prepare() {
      method = await readMethod();
    },
    acquire() {
      const cams = deps.streams()!; // `ready()` guaranteed non-null
      const entries = Object.entries(cams);

      // Route ALL recorded raw streams through the zlib CompressStream brick when
      // the app-level method is "zlib" (the recorder consumes the `/zlib` sibling
      // pipe INSTEAD — advert-verbatim, zero extra config, on-disk contract
      // unchanged). Absent brick seam → degrade to raw (vitest without core).
      const useCompress = method === "zlib" && !!deps.compress;

      const acquisitions: RawPipeAcquisition[] = [];
      const streams: Record<string, { pipeId: string }> = {};
      const significantBitsOf = new Map<string, number>();
      const compressed: CompressHandle[] = [];
      for (const [name, camera] of entries) {
        const pipeId = `camera/${camera.serial}/raw`;
        const acq = deps.rawPipes.acquire({
          kind: "raw",
          camera,
          pipeId,
          spec: rawPipeSpec(camera, pipeId, DEFAULT_RAW_RING_DEPTH),
        });
        acquisitions.push(acq);
        significantBitsOf.set(acq.pipeId, acq.spec.significantBits);
        if (useCompress) {
          const handle = createCompressPipe(deps.compress!, acq.spec);
          compressed.push(handle);
          significantBitsOf.set(handle.pipeId, handle.spec.significantBits);
          streams[name] = { pipeId: handle.pipeId };
        } else {
          streams[name] = { pipeId: acq.pipeId };
        }
      }

      // Ruling-8 significantBits injection (the native spec round-trip drops it
      // — the advertiser's job): wrap the plain broker connect to re-attach the
      // JS-side significantBits recorded for each advertised id (raw AND /zlib).
      const connect: RecorderConnect = (pipeId) => {
        const handle = deps.broker.connect(pipeId);
        const sb = significantBitsOf.get(pipeId);
        return {
          shmName: handle.shmName,
          spec: sb === undefined ? handle.spec : { ...handle.spec, significantBits: sb },
          release: () => void deps.broker.disconnect(pipeId),
        };
      };

      return {
        nodeOptions: { streams, connect },
        // Retire compress bricks first (they consume the raw pipes), then release
        // ALL acquisitions in reverse (last release retires + unadvertises).
        release: () => {
          for (const c of compressed) c.retire();
          for (const a of [...acquisitions].reverse()) a.release();
        },
      };
    },
  });
}
