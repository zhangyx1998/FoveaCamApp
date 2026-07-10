// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The STANDALONE viewer's playback ENGINE (standalone-viewer-and-fcap ruling 1,
// AS SHIPPED amendment). A MAIN-owned `utilityProcess` — one per viewer window,
// one open container per process. It USED to be a `worker_threads.Worker`
// spawned from the viewer window's preload, but Electron renderer processes
// cannot construct Node workers ("The V8 platform used by this instance of Node
// does not support creating Workers"), so main forks it exactly like the
// orchestrator/janitor. Hosts the whole data layer OUT of the window process:
// MCAP reading (source.ts), frame decode (decode.ts — loads `core/Vision`
// lazily under the explicit no-core-in-renderer exception), and timestamp-paced
// playback (player.ts). The orchestrator is never involved — it's MAIN that
// owns this engine — so playback keeps working while the orchestrator is down,
// busy, or restarting: the point of the ruling.
//
// PORT TOPOLOGY: main creates a `MessageChannelMain`, forks this engine, and
// posts `{ type: "init", file }` over `process.parentPort` WITH `port1`
// transferred; `port2` goes to the window via `webContents.postMessage`. This
// engine drives the viewer protocol over that transferred port (a
// MessagePortMain). Cross-process `postMessage` SERIALIZES (structured-clone
// COPY) — a MessagePortMain transfer list carries ports only, never
// ArrayBuffers, so frame buffers are COPIED to the renderer (fine for
// playback; zero-copy was only ever available same-process).
//
// Bundled as its own vite entry (`viewer-worker.js`, next to main in
// `.dist/electron/`) exactly like the orchestrator: main forks it via
// `utilityProcess.fork(path.join(DIR, "viewer-worker.js"))`. `core` and
// `@mcap/core` stay external and resolve from node_modules like the
// orchestrator bundle's own runtime requires.

import { readFile, writeFile } from "node:fs/promises";
import type { MessagePortMain } from "electron";
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

// The renderer channel (MessagePortMain, transferred to us by main over the
// `init` message). Null until `init` arrives; the parent (main) channel is
// `process.parentPort`, used only for lifecycle (init / close→flushed).
let renderer: MessagePortMain | null = null;

function post(event: ViewerEvent): void {
  // MessagePortMain.postMessage serializes across the process boundary and its
  // transfer list carries ONLY ports — never ArrayBuffers (that throws). Frame
  // buffers cross as a structured-clone copy; no transfer list.
  renderer?.postMessage(event);
}

/** Post one decoded display frame. The buffer is COPIED to the renderer
 *  (cross-process structured clone). We still COMPACT a Mat that merely views a
 *  larger buffer (the pure-U8 no-copy decode path can alias the whole MCAP
 *  chunk buffer) via `slice()` first — otherwise structured clone would copy
 *  the ENTIRE backing chunk, not just this frame. A Mat that owns its buffer
 *  outright posts as-is. */
function postFrame(channel: string, mat: Mat<Uint8Array>, convertMs: number): void {
  const owns = mat.byteOffset === 0 && mat.byteLength === mat.buffer.byteLength;
  const bytes = owns ? mat : mat.slice();
  post({
    type: "frame",
    channel,
    buffer: bytes.buffer as ArrayBuffer,
    byteOffset: bytes.byteOffset,
    length: bytes.length,
    shape: [...mat.shape],
    channels: mat.channels,
    convertMs,
  });
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

/** Flush any pending sidecar write NOW (idempotent). Called before the engine
 *  dies — from the renderer's `close` command (pagehide) and from main's
 *  parent-port `close` (the authoritative teardown, since the window may already
 *  be gone). */
async function flushSidecar(): Promise<void> {
  if (!sidecarTimer) return;
  clearTimeout(sidecarTimer);
  sidecarTimer = null;
  const s = pendingSidecar;
  const path = openedPath;
  pendingSidecar = null;
  if (s && path)
    await writeFile(sidecarPathFor(path), serializeSidecar(s), "utf8").catch(() => {});
}

async function close(): Promise<void> {
  const p = player;
  player = null;
  source = null;
  await flushSidecar();
  openedPath = null;
  await p?.close(); // also closes the source
}

/** Handle one viewer protocol command over the renderer port. (`open` is no
 *  longer a command — main hands the file in `init` and we open eagerly.) */
function handleCommand(msg: ViewerCommand): void {
  try {
    switch (msg?.type) {
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
}

// --- lifecycle over the PARENT (main) port ----------------------------------
// `process.parentPort` exists only in a utilityProcess. Main drives:
//   { type: "init", file } + [port1]  → wire the renderer channel + open `file`
//   { type: "close" }                 → flush the sidecar, then ack `flushed`
const main = process.parentPort;
if (!main) throw new Error("viewer engine must run as a utilityProcess");

main.on("message", (e) => {
  const msg = e.data as { type?: string; file?: string } | null;
  if (msg?.type === "init") {
    const p = e.ports[0];
    if (!p) return;
    renderer = p;
    renderer.on("message", (ev) => handleCommand(ev.data as ViewerCommand));
    renderer.start();
    if (typeof msg.file === "string" && msg.file) void open(msg.file);
    return;
  }
  if (msg?.type === "close") {
    // Flush-before-close (single-writer sidecar): land the pending write, then
    // ack so main kills us within its bounded grace instead of on a timeout.
    void flushSidecar().finally(() => main.postMessage({ type: "flushed" }));
    return;
  }
});
