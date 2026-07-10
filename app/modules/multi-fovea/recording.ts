// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Multi-fovea session RECORDING controller (multi-fovea-recording r2.1, wave
// I-2). A multi-fovea recording contains ONLY:
//   1. the three PACKED `camera/<serial>/raw12p` sensor streams (left/center/
//      right — verbatim wire payload, ruling 1), acquired through the
//      refcounted raw-pipe registry (ruling 5) with optional per-stream zlib
//      compression routed through the CompressStream brick (ruling 9 — the
//      recorder consumes the `/zlib` sibling pipe instead, zero extra config);
//   2. the wide camera's singleton metadata record (ruling 2);
//   3. per-target DESCRIPTOR channels (`fovea/<slot>`, ruling 3) — JSON
//      observations `{tNs, bbox, frames:{left,center,right}}` where the frame
//      pointers are per-stream recorder sequences; fovea imagery is
//      reconstructed OFFLINE, never re-encoded.
//
// DESCRIPTOR EMISSION (one path, both modes): every tracker-batch observation
// of an armed target emits one descriptor — bbox comes from the batch (wide,
// undistorted coords). The L/R pointers are enriched from PAIR RECORDS
// (pairing-nodes): the root PairStream's completed pairs carry the two matched
// frames' deviceTimestamps; the recorder's per-frame notices build dts→seq
// maps for the recorded raw12p streams (the tap stamps identically to the
// Frame path), so a fresh pair for the target's controller stream re-keys to
// recorded sequences. In FREE-RUN there are no pairs (trigger-only anchors,
// ruling 1) so descriptors carry `left: null, right: null` — bbox + center
// pointer only (the documented shape; see docs/schema/fovea.ts). The center
// pointer is the NEAREST recorded center frame by timestamp and is explicitly
// UNSYNCHRONIZED (CAM0 GPIO is uncabled — no hardware trigger on the wide
// camera).
//
// PER-FRAME EXTRAS (ruling 4): the L/R fovea streams answer `onFrame` with the
// matched anchor's payload (volts / V2A angles / H, unpacked from the opaque
// doubles the enrichment node packed) — exact dts→anchor binding, null when no
// anchor matched (free-run). The wide stream posts none (its camera matrix is
// the §2 singleton) but still notices: its dts→seq map is what the descriptor
// center pointer is built from.
//
// Injection-seamed like manual-control's controller: no native imports, the
// recorder node factory is injectable, so vitest drives the whole thing with
// fakes.
//
// capture-recorder-everywhere ruling 1: the start/stop/poll/telemetry/error-
// unwind skeleton lifted into the composable `@orchestrator/recording-service`
// facility — this file keeps ONLY multi-fovea's semantics (raw12p streams,
// optional /zlib compression routing, descriptor channels, extras/dts maps).
// Observable behavior is unchanged (see multi-fovea-recording.test.ts).

import type { Rect } from "core/Geometry";
import {
  type RecorderConnect,
  type RecorderNodeHandle,
  type RecorderNodeOptions,
  type RecorderStreamStats,
  type FoveaDescriptor,
} from "@orchestrator/recorder-node";
import { createRecordingService } from "@orchestrator/recording-service";
import {
  raw12pPipeSpec,
  type RawPipeRegistry,
  type RawPipeAcquisition,
  type RawGeometrySource,
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
import { ANCHOR_PAYLOAD } from "@orchestrator/anchor-node";
import type { PairRecord } from "@orchestrator/pair-pipe";
import type { MultiTrackBatch } from "./runtime";

/** The recorded stream names — also the descriptor `frames` keys. */
export type RecordedStream = "left" | "center" | "right";

/** Per-stream compression switches (session contract option, default all off).
 *  Per-stream ENABLES of the app-level `record_compression` method: a stream
 *  compresses iff the method is `"zlib"` AND its switch is on (`"none"` gates all
 *  off). Lossless zlib may not hold full-rate 12p on all three cameras; rig-gated. */
export type CompressConfig = Record<RecordedStream, boolean>;

/** One leased camera the recording taps: the geometry source (serial /
 *  pixel_format / dims) + the opaque native handle the raw12p attach needs. */
export interface RecordingCamera {
  source: RawGeometrySource;
  camera: unknown;
}

/** The per-target slice of the session's telemetry this controller consumes
 *  (channel churn + controller-stream mapping). */
export interface RecordingTarget {
  index: number;
  enabled: boolean;
  streamId: number | null;
}

export interface MultiFoveaRecordingDeps {
  /** The leased L/C/R cameras, or null when the session isn't active. */
  cameras(): Record<"L" | "C" | "R", RecordingCamera> | null;
  /** Wide camera singleton metadata (ruling 2) — intrinsics/distortion from
   *  the calibration triple; null on an uncalibrated rig (record omitted). */
  wideCamera(): Record<string, unknown> | null;
  /** Refcounted raw-pipe registry (ruling 5). Injected from index.ts. */
  rawPipes: RawPipeRegistry;
  /** Plain broker connect (refcount++ → C-21 gate → producer runs). The
   *  controller wraps it to inject each advert's JS-side `significantBits`
   *  (the native PipeSpec drops it; ruling 8 — the advertiser's job). */
  connect: RecorderConnect;
  /** Compression brick seam; absent → the compress switches are ignored. */
  compress?: CompressPipeSeam;
  /** Live per-stream compression switches (read at `start`). Under the app-level
   *  `record_compression` method these are per-stream ENABLES of the CONFIGURED
   *  method: a stream compresses iff the method is `"zlib"` AND its switch is on.
   *  Under `"none"` the renderer disables the switches and nothing compresses. */
  compressStreams(): CompressConfig;
  /** Test seam: read the configured app-level compression method at RECORDING
   *  START (default: `readRecordCompression()` over the store-hub `["config"]`
   *  doc). `"none"` gates every stream off regardless of the per-stream switches. */
  readMethod?: () => Promise<RecordCompression>;
  /** Notify main a recording finished (auto-open viewer, ruling 7). */
  finished(foveaPath: string): void;
  telemetry(patch: {
    recording_active?: boolean;
    recordingStreams?: Record<string, RecorderStreamStats>;
  }): void;
  /** Test seam: the recorder node factory (default: the real one). */
  createNode?: (options: RecorderNodeOptions) => RecorderNodeHandle;
}

export interface MultiFoveaRecordingController {
  /** True while recording (drain-refusal probe, manual-control pattern). */
  readonly active: boolean;
  start(path: string): Promise<boolean>;
  stop(): Promise<boolean>;
  /** Session wiring: one completed ROOT pair record (trigger mode). Builds the
   *  dts→anchor maps for extras + the per-stream pair freshness the descriptor
   *  L/R pointers key on. Cheap; safe to call while idle. */
  onPairRecord(rec: PairRecord): void;
  /** Session wiring: one native tracker batch → descriptor emission for every
   *  armed target with a bbox. No-op while idle. */
  onTrackBatch(batch: MultiTrackBatch): void;
  /** Session wiring: the live target set (from the runtime's publish flow) —
   *  descriptor channels churn with target arm/disarm (add/removeDataStream)
   *  and the controller-stream map updates. Safe while idle (snapshotted for
   *  the next start). */
  onTargets(targets: RecordingTarget[]): void;
}

/** Bounded-map cap: ~2× the recorder ring depth (48) — a descriptor arriving
 *  after its frames evicted records null pointers rather than stalling. */
const MAP_CAP = 96;

/** A pair record older than this (ms) no longer binds L/R pointers to new
 *  descriptors — the round-robin schedule revisits each target far faster than
 *  this in live trigger capture; stale pairs degrade to free-run shape. */
const PAIR_FRESH_MS = 1000;

/** Insert with evict-oldest (Map preserves insertion order). */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAP_CAP) map.delete(map.keys().next().value as K);
}

/** The descriptor doc this controller writes: the ruled shape with EXPLICIT
 *  nulls for absent pointers (free-run L/R; an evicted/unmatched key). */
export interface MultiFoveaDescriptor {
  tNs: number;
  bbox: Rect;
  frames: { left: number | null; center: number | null; right: number | null };
}

/** Unpack the anchor payload's per-side extras (the enrichment node's opaque
 *  doubles — anchor-node.ts ANCHOR_PAYLOAD layout) into the telemetry-channel
 *  extras shape (manual-control's key spelling, `volt.source: fin-averaged` —
 *  anchor volts ARE the FIN's exposure-averaged reading). Volts-only payloads
 *  (uncalibrated) omit angle/affine. */
export function anchorExtras(
  payload: Float64Array,
  side: "L" | "R",
): Record<string, unknown> | null {
  if (payload.length < ANCHOR_PAYLOAD.LEN_VOLTS_ONLY) return null;
  const o = side === "L" ? 0 : 2;
  const extras: Record<string, unknown> = {
    volt: { x: payload[ANCHOR_PAYLOAD.VOLTS + o], y: payload[ANCHOR_PAYLOAD.VOLTS + o + 1] },
    "volt.unit": "volt",
    "volt.source": "fin-averaged",
  };
  if (payload.length >= ANCHOR_PAYLOAD.LEN_FULL) {
    extras.angle = {
      x: payload[ANCHOR_PAYLOAD.ANGLES + o],
      y: payload[ANCHOR_PAYLOAD.ANGLES + o + 1],
    };
    extras["angle.unit"] = "radian";
    const h = side === "L" ? ANCHOR_PAYLOAD.H_LEFT : ANCHOR_PAYLOAD.H_RIGHT;
    extras.affine = Array.from(payload.subarray(h, h + 9));
  }
  return extras;
}

export function createMultiFoveaRecording(
  deps: MultiFoveaRecordingDeps,
): MultiFoveaRecordingController {
  // --- dts→seq + dts→anchor state (see header) ------------------------------
  const seqByDts: Record<"left" | "right", Map<bigint, number>> = {
    left: new Map(),
    right: new Map(),
  };
  const anchorByDts: Record<"left" | "right", Map<bigint, Float64Array>> = {
    left: new Map(),
    right: new Map(),
  };
  /** Recent recorded CENTER frames (insertion = time order) for the nearest-
   *  by-timestamp pointer (explicitly unsynchronized — CAM0 GPIO uncabled). */
  const centerFrames: Array<{ tNs: bigint; seq: number }> = [];
  /** Latest pair per controller stream id → the descriptor L/R binding. */
  const pairByStream = new Map<number, { leftDts: bigint; rightDts: bigint; at: number }>();
  /** Slot index → controller stream id (from the session's target telemetry). */
  const streamBySlot = new Map<number, number>();
  /** Live descriptor channels (`fovea/<slot>`), churned with targets. */
  const liveChannels = new Set<string>();
  /** Last target snapshot — applied at start (channels for already-armed
   *  targets) and diffed on churn. */
  let targetSnapshot: RecordingTarget[] = [];

  function clearMaps(): void {
    seqByDts.left.clear();
    seqByDts.right.clear();
    anchorByDts.left.clear();
    anchorByDts.right.clear();
    centerFrames.length = 0;
    pairByStream.clear();
    liveChannels.clear();
  }

  function nearestCenterSeq(tNs: bigint): number | null {
    let best: number | null = null;
    let bestDelta: bigint | null = null;
    for (const f of centerFrames) {
      const d = f.tNs > tNs ? f.tNs - tNs : tNs - f.tNs;
      if (bestDelta === null || d < bestDelta) {
        bestDelta = d;
        best = f.seq;
      }
    }
    return best;
  }

  /** Ruling-3/4 per-frame callback: L/R answer with the matched anchor's
   *  extras (exact dts binding); center records its dts→seq sample and posts
   *  none (extras gating — the wide camera matrix is the §2 singleton). */
  function onFrame(stream: string, seq: number, tNs: bigint): Record<string, unknown> | null {
    if (stream === "center") {
      centerFrames.push({ tNs, seq });
      if (centerFrames.length > MAP_CAP) centerFrames.shift();
      return null;
    }
    if (stream !== "left" && stream !== "right") return null;
    boundedSet(seqByDts[stream], tNs, seq);
    const payload = anchorByDts[stream].get(tNs);
    if (!payload) return null; // free-run / unmatched — a frame without extras
    return anchorExtras(payload, stream === "left" ? "L" : "R");
  }

  /** Diff the live channel set against the enabled targets (ruling 3 churn).
   *  Only meaningful with a live node; the snapshot persists for `start`. */
  function syncChannels(): void {
    const node = service.node;
    if (!node) return;
    const want = new Set(
      targetSnapshot.filter((t) => t.enabled).map((t) => `fovea/${t.index}`),
    );
    for (const name of liveChannels)
      if (!want.has(name)) {
        liveChannels.delete(name);
        node.removeDataStream(name);
      }
    for (const name of want)
      if (!liveChannels.has(name)) {
        liveChannels.add(name);
        node.addDataStream(name);
      }
  }

  const readMethod = deps.readMethod ?? readRecordCompression;
  // The app-level compression method, read at RECORDING START (`prepare`). The
  // per-stream switches are ENABLES of THIS method: a stream compresses iff the
  // method is "zlib" AND its switch is on. "none" gates every stream off.
  let method: RecordCompression = "none";

  // Thin config over the shared facility (capture-recorder-everywhere ruling 1):
  // the raw12p streams + optional /zlib compression routing + the descriptor
  // `onFrame`. The facility owns start/stop/poll/telemetry + the acquire-then-
  // build error unwind (compress bricks retired, raw acquisitions released in
  // reverse — symmetric with the documented discipline).
  const service = createRecordingService({
    id: "recorder/multi-fovea",
    createNode: deps.createNode,
    ready: () => deps.cameras() !== null,
    telemetry: deps.telemetry,
    finished: deps.finished,
    async prepare() {
      method = await readMethod();
    },
    // Channels for targets already armed at start (ruling 3).
    onStarted: () => syncChannels(),
    onStopped: () => clearMaps(),
    acquire() {
      const cams = deps.cameras()!; // `ready()` guaranteed non-null

      // Refcounted raw12p acquire (rulings 1/5): the PACKED verbatim wire
      // payload per camera, deep recorder ring (default 48), ONE advertise per
      // id ever — shared with any concurrent acquirer.
      const acquire = (cam: RecordingCamera): RawPipeAcquisition =>
        deps.rawPipes.acquire({
          kind: "raw12p",
          camera: cam.camera,
          pipeId: `camera/${cam.source.serial}/raw12p`,
          spec: raw12pPipeSpec(cam.source),
        });
      const order: Array<[RecordedStream, RecordingCamera]> = [
        ["left", cams.L],
        ["center", cams.C],
        ["right", cams.R],
      ];
      const acquisitions = order.map(([, cam]) => acquire(cam));

      // Optional per-stream compression (ruling 9): route the flagged streams
      // through the CompressStream brick and record the `/zlib` sibling pipe
      // INSTEAD — the recorder needs zero extra config (advert-verbatim). Gated
      // by the app-level method: under "none" the per-stream switches are inert
      // (nothing compresses, matching the disabled renderer switches).
      const compressCfg = deps.compressStreams();
      const methodOn = method === "zlib";
      const streams: Record<string, { pipeId: string }> = {};
      const significantBitsOf = new Map<string, number>();
      const compressed: CompressHandle[] = [];
      order.forEach(([name], i) => {
        const acq = acquisitions[i]!;
        significantBitsOf.set(acq.pipeId, acq.spec.significantBits);
        if (methodOn && compressCfg[name] && deps.compress) {
          const handle = createCompressPipe(deps.compress, acq.spec);
          compressed.push(handle);
          significantBitsOf.set(handle.pipeId, handle.spec.significantBits);
          streams[name] = { pipeId: handle.pipeId };
        } else {
          streams[name] = { pipeId: acq.pipeId };
        }
      });

      // Ruling 8: the advertiser injects the JS-side significantBits the native
      // spec round-trip drops — for raw AND compressed pipes.
      const connect: RecorderConnect = (pipeId) => {
        const conn = deps.connect(pipeId);
        const sb = significantBitsOf.get(pipeId);
        return sb === undefined
          ? conn
          : { ...conn, spec: { ...conn.spec, significantBits: sb } };
      };

      return {
        nodeOptions: {
          streams,
          connect,
          // Ruling 2: the wide camera's singleton metadata record (omitted on an
          // uncalibrated rig).
          cameraMatrix: deps.wideCamera() ?? undefined,
          // Every stream posts notices: L/R for extras + dts→seq re-keying,
          // center for the descriptor nearest-pointer map (it still POSTS no
          // extras — onFrame returns null for it, so nothing rides telemetry).
          onFrame,
        },
        // Retire compress bricks first (they consume the raw pipes), then release
        // ALL acquisitions in reverse order (last release retires + unadvertises).
        release: () => {
          for (const c of compressed) c.retire();
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

    onPairRecord(rec: PairRecord): void {
      boundedSet(anchorByDts.left, rec.left.deviceTimestamp, rec.payload);
      boundedSet(anchorByDts.right, rec.right.deviceTimestamp, rec.payload);
      pairByStream.set(rec.stream, {
        leftDts: rec.left.deviceTimestamp,
        rightDts: rec.right.deviceTimestamp,
        at: performance.now(),
      });
    },

    onTrackBatch(batch: MultiTrackBatch): void {
      const node = service.node;
      if (!node || !service.active) return;
      // The batch IS a center-camera observation; when the source doesn't
      // stamp device time, the latest recorded center frame is the nearest
      // sample by construction.
      const tNs =
        batch.deviceTimestamp ?? centerFrames[centerFrames.length - 1]?.tNs ?? 0n;
      const now = performance.now();
      for (const t of batch.targets) {
        if (!t.ok || !t.bbox) continue;
        const slot = Number(t.id);
        const channel = `fovea/${slot}`;
        if (!liveChannels.has(channel)) continue;
        // Trigger mode: a FRESH pair for this target's controller stream
        // re-keys to recorded L/R sequences; free-run/stale → explicit nulls.
        const streamId = streamBySlot.get(slot);
        const pair = streamId !== undefined ? pairByStream.get(streamId) : undefined;
        const fresh = pair !== undefined && now - pair.at < PAIR_FRESH_MS;
        const descriptor: FoveaDescriptor = {
          tNs: Number(tNs),
          bbox: t.bbox,
          frames: {
            left: fresh ? seqByDts.left.get(pair.leftDts) ?? null : null,
            center: nearestCenterSeq(tNs),
            right: fresh ? seqByDts.right.get(pair.rightDts) ?? null : null,
          },
        };
        node.postData(channel, descriptor);
      }
    },

    onTargets(targets: RecordingTarget[]): void {
      targetSnapshot = targets;
      streamBySlot.clear();
      for (const t of targets)
        if (t.streamId !== null) streamBySlot.set(t.index, t.streamId);
      syncChannels();
    },
  };
}
