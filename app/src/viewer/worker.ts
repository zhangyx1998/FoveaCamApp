// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The STANDALONE viewer's playback worker (standalone-viewer-and-fcap ruling
// 1). A `worker_threads.Worker` spawned by the viewer window's dedicated
// preload (preload-viewer.ts) — one worker per window, one open container per
// worker. Hosts the whole data layer in the WINDOW's process: MCAP reading
// (source.ts), frame decode (decode.ts — loads `core/Vision` lazily under the
// explicit no-core-in-renderer exception), and timestamp-paced playback
// (player.ts). The orchestrator is never involved: playback keeps working
// while it is down, busy, or restarting — that's the point of the ruling.
//
// Decode runs HERE, off the window's UI thread; decoded Mats post to the
// preload with their buffers in the transfer list (the preload re-transfers
// onto the renderer's DOM port — zero copies end to end).
//
// Bundled as its own vite entry (`viewer-worker.js`, next to the preloads in
// `.dist/electron/`) exactly like `vision-worker.js`: the preload resolves it
// via `path.join(__dirname, "viewer-worker.js")` at runtime. `core` and
// `@mcap/core` stay external and resolve from node_modules like the
// orchestrator bundle's own runtime requires.

import { parentPort } from "node:worker_threads";
import type { Mat } from "core/Vision";
import { createFrameDecoder } from "./decode.js";
import { createPlayer, nullMeter, type Player } from "./player.js";
import { openFovea, type FoveaSource } from "./source.js";
import type { ViewerCommand, ViewerEvent } from "./protocol.js";

const port = parentPort;
if (!port) throw new Error("viewer-worker must run as a worker thread");

function post(event: ViewerEvent, transfer?: ArrayBuffer[]): void {
  port!.postMessage(event, transfer);
}

/** Post one decoded display frame, TRANSFERRING its buffer when the Mat owns
 *  it outright. A Mat that merely views a larger buffer (the pure-U8 no-copy
 *  decode path can alias the MCAP chunk buffer, which later messages of the
 *  same chunk still need) is copied first — transferring the underlying
 *  buffer would detach it out from under the reader. */
function postFrame(channel: string, mat: Mat<Uint8Array>, convertMs: number): void {
  const owns = mat.byteOffset === 0 && mat.byteLength === mat.buffer.byteLength;
  const bytes = owns ? mat : mat.slice();
  post(
    {
      type: "frame",
      channel,
      buffer: bytes.buffer as ArrayBuffer,
      byteOffset: bytes.byteOffset,
      length: bytes.length,
      shape: [...mat.shape],
      channels: mat.channels,
      convertMs,
    },
    [bytes.buffer as ArrayBuffer],
  );
}

let source: FoveaSource | null = null;
let player: Player | null = null;
let opening = false;

async function open(path: string): Promise<void> {
  if (opening || source) return; // one container per worker; re-open is a no-op
  opening = true;
  try {
    const s = await openFovea(path);
    source = s;
    player = createPlayer(
      s,
      (channel) => createFrameDecoder(channel.metadata),
      nullMeter,
      {
        publishFrame: postFrame,
        emitTelemetry: (doc) => post({ type: "telemetry", doc }),
        emitDescriptor: (topic, doc) => post({ type: "descriptor", topic, doc }),
        emitPosition: (positionNs, playing) =>
          post({ type: "position", positionNs, playing }),
      },
    );
    post({
      type: "opened",
      info: {
        path,
        channels: s.channels.map((c) => ({ name: c.topic, metadata: c.metadata })),
        durationNs: Number(s.endNs - s.startNs),
        truncated: s.truncated,
      },
    });
  } catch (error) {
    post({
      type: "open-error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    opening = false;
  }
}

async function close(): Promise<void> {
  const p = player;
  player = null;
  source = null;
  await p?.close(); // also closes the source
}

port.on("message", (msg: ViewerCommand) => {
  try {
    switch (msg?.type) {
      case "open":
        void open(msg.path);
        break;
      case "play":
        player?.play(msg.rate);
        break;
      case "pause":
        player?.pause();
        break;
      case "seek":
        void player?.seek(msg.tNs).catch((error) => {
          post({ type: "error", message: String(error) });
        });
        break;
      case "close":
        void close();
        break;
    }
  } catch (error) {
    post({ type: "error", message: String(error) });
  }
});
