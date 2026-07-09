// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// STANDALONE viewer wire protocol (standalone-viewer-and-fcap ruling 1): the
// message shapes between the viewer window (main world), its preload relay,
// and the viewer worker thread. The viewer does NOT interface with the
// orchestrator — this file replaces the retired pinned session contract
// (`@lib/orchestrator/viewer-contract`); both sides now live in ONE window
// process, so the protocol is window-local and free to evolve with the code.
//
// Topology: ViewerWindow.vue creates a DOM `MessageChannel`, keeps port1 and
// hands port2 to the preload via `window.postMessage({kind: VIEWER_INIT})`
// (the established SHM_INIT pattern — a DOM port is the only channel that
// crosses the isolated-world boundary with transferables). The preload spawns
// the bundled worker (`viewer-worker.js`, a `worker_threads.Worker`) and
// relays verbatim: commands renderer → worker, events worker → renderer,
// transferring frame buffers on both hops (zero copies).
//
// One window = one file = one worker; there is no fileId keying (the
// one-window-per-file dedupe lives in main.ts's window manager).
//
// Renderer-safe and Node-free: types + string constants only.

/** `window.postMessage` handshake kind — carries the renderer's MessagePort
 *  to the preload (see preload-viewer.ts). */
export const VIEWER_INIT = "fovea:viewer:init";

/** One channel of the open container, as shown in the viewer's track list.
 *  `metadata` is the channel's MCAP metadata (the §2b static decode props for
 *  `x-fovea-raw` channels) plus a folded-in `messageEncoding` key so the UI
 *  can tell json (telemetry/descriptor) tracks from frame tracks. */
export type ViewerChannelInfo = {
  name: string;
  metadata: Record<string, string>;
};

/** The static half of an open container. Times are nanoseconds RELATIVE to
 *  the file's first message (0..durationNs) — the natural scrub-bar domain;
 *  plain numbers, not bigints (2^53 ns ≈ 104 days). */
export type ViewerFileInfo = {
  path: string;
  channels: ViewerChannelInfo[];
  durationNs: number;
  /** True when the container had no MCAP footer (crash-truncated recording)
   *  and was opened through the streaming re-index fallback. */
  truncated: boolean;
};

/** One replayed json-channel document (parsed JSON — telemetry extras or a
 *  `fovea/<target>` descriptor). */
export type PlaybackDoc = Record<string, unknown>;

/** Renderer → worker commands. */
export type ViewerCommand =
  | { type: "open"; path: string }
  | { type: "play"; rate: number }
  | { type: "pause" }
  | { type: "seek"; tNs: number }
  | { type: "close" };

/** One decoded display frame. `buffer` is TRANSFERRED (never copied across
 *  the two hops); reconstruct the Mat as
 *  `Object.assign(new Uint8Array(buffer, byteOffset, length), {shape, channels})`. */
export type ViewerFrameEvent = {
  type: "frame";
  channel: string;
  buffer: ArrayBuffer;
  byteOffset: number;
  length: number;
  shape: number[];
  channels: number;
  convertMs: number;
};

/** Worker → renderer events. */
export type ViewerEvent =
  | { type: "opened"; info: ViewerFileInfo }
  | { type: "open-error"; message: string }
  | { type: "position"; positionNs: number; playing: boolean }
  | { type: "telemetry"; doc: PlaybackDoc }
  | { type: "descriptor"; topic: string; doc: PlaybackDoc }
  | ViewerFrameEvent
  | { type: "error"; message: string };
