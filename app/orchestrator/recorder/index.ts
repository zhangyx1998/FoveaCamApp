// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Production recorder facade (B-5; docs/refactor/recorder-container.md §2
// decision + §3). Recording sessions write a single `.fovea` container —
// standard MCAP inside — through one worker_threads writer per topology key
// (`singleFileTopology` today: exactly one worker, one file). The legacy
// `.stream`/`.meta`/manifest backend stays in-tree behind `RECORDER_BACKEND`
// as the fallback.
//
// Container layout (documented in the per-dump README):
// - one channel per recorded stream, `messageEncoding: "x-fovea-raw"` —
//   message bytes are the frame exactly as captured (12p stays packed);
//   channel metadata carries the static decode props (dtype/shape/
//   pixelFormat/significantBits/channels), taken from the stream's first
//   frame;
// - one `telemetry` channel (JSON): per-frame extras — volt/angle/
//   homography, the legacy sidecar's `x` payload — sent only for frames
//   that have extras, correlated by stream+seq (or logTime);
// - MCAP metadata records `fovea:session` (ISO timestamp) and
//   `fovea:finalize` (durationSec).
//
// Timestamps: logTime/publishTime are nanoseconds on the same clock the
// legacy writer used (`performance.now()/1000` seconds) — relative to
// process start, monotonic across every channel of a session; the absolute
// wall-clock anchor is the `fovea:session` metadata record.

import fs from "node:fs/promises";
import { resolve } from "node:path";
import type { PixelFormat } from "core/Aravis";
import type { Mat } from "core/Vision";
import { FreqMeter } from "@lib/util/rolling";
import { dtypeOf, significantBits } from "@lib/util/dtype";
import { McapWriterWorker, type McapWriterWorkerOptions } from "./writer.js";
import { createLegacySink } from "./legacy.js";
import {
  singleFileTopology,
  type RecorderTopology,
  type StreamStats,
} from "./types.js";
import {
  FOVEA_EXTENSION,
  FINALIZE_METADATA_NAME,
  RAW_FRAME_MESSAGE_ENCODING,
  RAW_FRAME_SCHEMA_DATA,
  RAW_FRAME_SCHEMA_NAME,
  SESSION_METADATA_NAME,
  TELEMETRY_TOPIC,
} from "./schema.js";

export { McapWriterWorker } from "./writer.js";
export {
  type RecorderTopology,
  type StreamStats,
  type FinalizeStats,
} from "./types.js";
export {
  FOVEA_EXTENSION,
  TELEMETRY_TOPIC,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_QUEUED_FRAMES,
  RAW_FRAME_MESSAGE_ENCODING,
  RAW_FRAME_SCHEMA_NAME,
  TELEMETRY_MESSAGE_ENCODING,
  TELEMETRY_SCHEMA_NAME,
} from "./schema.js";
export { singleFileTopology } from "./types.js";

export type RecorderBackend = "fovea" | "legacy";

/** Recording backend selector. `"fovea"` = the new single-file MCAP
 *  container; flip to `"legacy"` to restore the pre-B-5 `.stream`/`.meta`/
 *  manifest dumps (the writer itself stays in-tree — `stream-writer.ts`). */
export const RECORDER_BACKEND: RecorderBackend = "fovea";

/** The format-agnostic surface `manual-control/recording.ts` records
 *  through — both backends implement it, so the session code never branches
 *  on container format. */
export interface RecordingSink {
  readonly kind: RecorderBackend;
  /** Write one frame on a named stream (lazily registers the stream on
   *  first use). Synchronous, never blocks the orchestrator loop — frames
   *  that cannot ship are dropped and accounted (never silently). */
  write(
    stream: string,
    frame: Mat,
    format: PixelFormat,
    timestampSec?: number,
    extra?: Record<string, unknown>,
  ): void;
  /** Per-stream counters for recording telemetry (frames/dropped/bytes/fps). */
  stats(): Record<string, StreamStats>;
  /** Flush everything, write indexes/summaries, release workers. */
  finalize(durationSec: number): Promise<void>;
}

/** Create the recording sink for a session directory using the backend
 *  selected by `RECORDER_BACKEND`. `timestamp` = the session's ISO string. */
export function createRecordingSink(
  basePath: string,
  timestamp: string,
): Promise<RecordingSink> {
  return RECORDER_BACKEND === "legacy"
    ? createLegacySink(basePath, timestamp)
    : createFoveaSink(basePath, timestamp);
}

export interface FoveaSinkOptions {
  /** Channel→writer mapping. Default: `singleFileTopology("recording")` —
   *  one worker, one `recording.fovea`. Sharding later = a new topology,
   *  additive (see types.ts). */
  topology?: RecorderTopology;
  /** Passed through to each writer worker (chunkBytes, maxQueuedFrames). */
  writer?: Pick<McapWriterWorkerOptions, "chunkBytes" | "maxQueuedFrames">;
}

const README = `# FoveaCam recording

This directory holds a single-file recording container (\`.fovea\`). The
content is a standard MCAP file (https://mcap.dev) — until the FoveaCam
Python package ships, any generic MCAP tooling reads it directly:

- \`mcap info recording.fovea\` / \`mcap cat\` (the mcap CLI)
- \`pip install mcap\` — \`mcap.reader.make_reader(open("recording.fovea", "rb"))\`

Layout: one channel per camera stream (message bytes are the raw frame as
captured — 12-bit-packed formats stay packed; the channel metadata carries
dtype / shape / pixelFormat / significantBits), plus a \`telemetry\` channel
of per-frame JSON documents ({stream, seq, t, volt/angle/affine…}) for the
frames that carry metadata. The \`${SESSION_METADATA_NAME}\` / \`${FINALIZE_METADATA_NAME}\`
metadata records hold the wall-clock timestamp and duration.
`;

interface StreamState {
  writer: McapWriterWorker;
  seq: number;
  frames: number;
  dropped: number;
  bytes: number;
  fps: FreqMeter;
}

/** The MCAP-backed sink. Exported directly (in addition to the
 *  `createRecordingSink` selector) so tests can drive it regardless of the
 *  `RECORDER_BACKEND` constant. */
export async function createFoveaSink(
  basePath: string,
  timestamp: string,
  options: FoveaSinkOptions = {},
): Promise<RecordingSink> {
  const topology = options.topology ?? singleFileTopology("recording");
  const session = { timestamp, app: "FoveaCamApp" };

  const writers = new Map<string, McapWriterWorker>();
  function writerFor(key: string): McapWriterWorker {
    let writer = writers.get(key);
    if (!writer) {
      const fileName = topology.fileNameFor(key);
      writer = new McapWriterWorker(resolve(basePath, fileName), fileName, {
        ...options.writer,
        session,
      });
      writers.set(key, writer);
    }
    return writer;
  }

  await fs.writeFile(resolve(basePath, "README.md"), README, "utf8");
  // Container file(s) exist from t0 — the legacy manifest-at-start parity
  // (an aborted/empty recording still leaves a valid, finalized container).
  for (const key of topology.initialWriterKeys()) writerFor(key);

  const streams = new Map<string, StreamState>();

  function streamFor(name: string, frame: Mat, format: PixelFormat): StreamState {
    let state = streams.get(name);
    if (!state) {
      const writer = writerFor(topology.writerKeyFor(name));
      // Static decode props from the first frame — per-frame variation is
      // not expected mid-recording (resolution/format are fixed while
      // streaming); per-frame extras ride the telemetry channel.
      writer.registerChannel(name, {
        schema: RAW_FRAME_SCHEMA_NAME,
        schemaData: RAW_FRAME_SCHEMA_DATA,
        messageEncoding: RAW_FRAME_MESSAGE_ENCODING,
        metadata: {
          dtype: dtypeOf(frame),
          shape: JSON.stringify([...frame.shape]),
          channels: String(frame.channels),
          pixelFormat: format,
          significantBits: String(significantBits(format)),
        },
      });
      state = { writer, seq: 0, frames: 0, dropped: 0, bytes: 0, fps: new FreqMeter() };
      streams.set(name, state);
    }
    return state;
  }

  return {
    kind: "fovea",

    write(stream, frame, format, timestampSec, extra) {
      const t = timestampSec ?? performance.now() / 1000;
      const state = streamFor(stream, frame, format);
      const extras = extra && Object.keys(extra).length > 0 ? extra : undefined;
      const metaPayload = extras
        ? JSON.stringify({ stream, seq: state.seq, t, ...extras })
        : undefined;
      const accepted = state.writer.writeFrame(
        stream,
        state.seq,
        BigInt(Math.round(t * 1e9)),
        () => {
          const data = new ArrayBuffer(frame.byteLength);
          new Uint8Array(data).set(
            new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
          );
          return data;
        },
        metaPayload,
      );
      if (accepted) {
        state.seq++;
        state.frames++;
        state.bytes += frame.byteLength;
        state.fps.tick();
      } else {
        state.dropped++;
      }
    },

    stats() {
      const out: Record<string, StreamStats> = {};
      for (const [name, s] of streams)
        out[name] = { frames: s.frames, dropped: s.dropped, bytes: s.bytes, fps: s.fps.value };
      return out;
    },

    async finalize(durationSec) {
      await Promise.all(
        [...writers.values()].map((w) =>
          w.finalize({ durationSec: String(durationSec) }),
        ),
      );
    },
  };
}
