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
import { readFile, writeFile } from "node:fs/promises";
import type { Mat } from "core/Vision";
import { createFrameDecoder } from "./decode.js";
import { createPlayer, nullMeter, type Player } from "./player.js";
import { openFovea, type FoveaSource } from "./source.js";
import type { ViewerCommand, ViewerEvent } from "./protocol.js";
import {
  classifySidecar,
  serializeSidecar,
  sidecarPathFor,
  type SidecarLoad,
  type SidecarState,
} from "./sidecar.js";

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
let openedPath: string | null = null;

// --- sidecar (ruling 8): debounced write-through, worker is the ONLY writer.
const SIDECAR_DEBOUNCE_MS = 400;
let sidecarTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSidecar: SidecarState | null = null;

async function readSidecar(fcapPath: string): Promise<SidecarLoad> {
  // Sidecar is a SEPARATE file next to the read-only container. ENOENT ⇒
  // ABSENT (renderer silently initializes); a present-but-broken file ⇒
  // CORRUPT (renderer confirms before overwrite) — ruling 10.
  let text: string | null = null;
  try {
    text = await readFile(sidecarPathFor(fcapPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return { status: "absent" };
    return { status: "corrupt" }; // unreadable (perms, etc.) — don't overwrite
  }
  return classifySidecar(text);
}

function scheduleSidecarWrite(state: SidecarState): void {
  pendingSidecar = state;
  if (sidecarTimer) return;
  sidecarTimer = setTimeout(() => {
    sidecarTimer = null;
    const s = pendingSidecar;
    const p = openedPath;
    pendingSidecar = null;
    if (!s || !p) return;
    // Never touches the .fcap — writes the adjacent `.fcap.ui.json` only.
    void writeFile(sidecarPathFor(p), serializeSidecar(s), "utf8").catch((error) => {
      post({ type: "error", message: `sidecar write failed: ${String(error)}` });
    });
  }, SIDECAR_DEBOUNCE_MS);
}

async function open(path: string): Promise<void> {
  if (opening || source) return; // one container per worker; re-open is a no-op
  opening = true;
  try {
    const [s, sidecar] = await Promise.all([openFovea(path), readSidecar(path)]);
    source = s;
    openedPath = path;
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
    const spans = await s.channelSpans();
    post({
      type: "opened",
      info: {
        path,
        channels: s.channels.map((c) => {
          const span = spans.get(c.topic);
          return {
            name: c.topic,
            metadata: c.metadata,
            // File-relative ns: absolute span minus the file's first message.
            startNs: span ? Number(span.startNs - s.startNs) : undefined,
            lastNs: span ? Number(span.endNs - s.startNs) : undefined,
          };
        }),
        durationNs: Number(s.endNs - s.startNs),
        truncated: s.truncated,
        wideCameraDeclared: s.wideCameraDeclared,
      },
      sidecar,
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
  // Flush any pending sidecar write before the handle drops.
  if (sidecarTimer) {
    clearTimeout(sidecarTimer);
    sidecarTimer = null;
    const s = pendingSidecar;
    const path = openedPath;
    pendingSidecar = null;
    if (s && path)
      await writeFile(sidecarPathFor(path), serializeSidecar(s), "utf8").catch(() => {});
  }
  openedPath = null;
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
      case "set-enabled":
        player?.setEnabled(msg.channels);
        break;
      case "save-ui":
        scheduleSidecarWrite(msg.state);
        break;
      case "close":
        void close();
        break;
    }
  } catch (error) {
    post({ type: "error", message: String(error) });
  }
});
