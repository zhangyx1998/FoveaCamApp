// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// STANDALONE viewer wire protocol (standalone-viewer-and-fcap ruling 1): the
// message shapes between the viewer window (main world) and the viewer ENGINE.
// The viewer does NOT interface with the orchestrator — this file replaces the
// retired pinned session contract (`@lib/orchestrator/viewer-contract`); the
// protocol is window-local and free to evolve with the code.
//
// Topology (AS SHIPPED amendment): the engine is a MAIN-owned `utilityProcess`
// (it can't be a renderer worker — Electron renderers can't construct Node
// workers). Main creates a `MessageChannelMain`, forks the engine with `port1`,
// and delivers `port2` to the window (`webContents.postMessage("viewer:port")`
// → preload relay → DOM `MessagePort`). The renderer talks DIRECTLY to the
// engine over that one port: commands renderer → engine, events engine →
// renderer. Cross-process = structured-clone COPY (frame buffers are copied,
// not transferred). Main hands the FILE to the engine in its `init` message, so
// there is no `open` command — the engine opens eagerly.
//
// One window = one file = one engine; there is no fileId keying (the
// one-window-per-file dedupe lives in main.ts's window manager, and one engine
// is keyed per window there).
//
// Renderer-safe and Node-free: types + string constants only.

import type { SidecarLoad, SidecarState } from "./sidecar.js";

/** One channel of the open container, as shown in the viewer's track list.
 *  `metadata` is the channel's MCAP metadata (the §2b static decode props for
 *  `x-fovea-raw` channels) plus a folded-in `messageEncoding` key so the UI
 *  can tell json (telemetry/descriptor) tracks from frame tracks. */
export type ViewerChannelInfo = {
  name: string;
  metadata: Record<string, string>;
  /** File-relative ns [startNs,lastNs] of this channel's FIRST and LAST
   *  message — the timeline block span (viewer-timeline §Blocks). Absent when
   *  the channel carried no message (registered but never written, or nothing
   *  recovered from a truncated tail): such a channel gets no block. */
  startNs?: number;
  lastNs?: number;
  /** Total messages on this channel over the file — the STATIC stat feeding the
   *  right-click stats popover (message count + average fps). Shipped in the
   *  `opened` payload so the popover's static half needs no engine round-trip.
   *  Absent when the container did not expose per-channel counts cheaply (no
   *  MCAP statistics summary) — the popover shows "—" rather than scanning. */
  messageCount?: number;
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
  /** True when the container carries a `fovea:wide-camera` metadata record —
   *  the recorder DECLARED a wide camera (viewer-timeline ruling 1). Drives
   *  the "no wide designation" hint alongside master detection (the record is
   *  container-level intrinsics with no channel pointer, so the master CHANNEL
   *  is chosen by naming convention, not this flag). */
  wideCameraDeclared: boolean;
};

/** One replayed json-channel document (parsed JSON — telemetry extras or a
 *  `fovea/<target>` descriptor). */
export type PlaybackDoc = Record<string, unknown>;

/** LIVE per-channel playback stats (the engine's half of the stats popover —
 *  the STATIC half rides the `opened` payload). Snapshot at reply time; the
 *  renderer re-requests to keep it current while the popover is open. */
export type StreamLiveStats = {
  /** Frames decoded + published on this channel this session. */
  decoded: number;
  /** Recent decode rate (frames/second) over a short sliding window; 0 when
   *  paused or fewer than two decodes are in the window. */
  rateHz: number;
  /** File-relative ns of the frame CURRENTLY shown for this channel (its last
   *  decoded frame's log-time) — compared against the playhead in the popover.
   *  null when nothing has decoded on this channel yet. */
  lastFrameNs: number | null;
};

/** Renderer → engine commands. (There is no `open` — main hands the file to
 *  the engine in its `init` message and the engine opens eagerly.) */
export type ViewerCommand =
  | { type: "play"; rate: number }
  | { type: "pause" }
  | { type: "seek"; tNs: number }
  /** The set of frame channels the worker should DECODE (viewer-timeline
   *  ruling 3/§Playback): only ENABLED, displayed streams. The worker skips
   *  decode for channels absent here (still ingested + accounted as dropped);
   *  a newly-added channel triggers a seek-refresh of that channel at the
   *  current playhead so it repaints immediately while paused. `channels` is
   *  the `decodeSet()` shape — sorted, de-duplicated topic names. */
  | { type: "set-enabled"; channels: string[] }
  /** Persist viewer UI state to the sidecar (ruling 8). The worker debounces
   *  and writes `<path>.fcap.ui.json`; the `.fcap` stays read-only. */
  | { type: "save-ui"; state: SidecarState }
  /** Ask the engine for LIVE stats on `channels` (one tile — a merged pair
   *  sends both L/R). The reply is a `stats` event echoing `requestId` so a
   *  late reply for a since-closed/replaced popover is discarded. */
  | { type: "get-stats"; requestId: number; channels: string[] }
  | { type: "close" };

/** One decoded display frame. `buffer` arrives as a fresh COPY (cross-process
 *  structured clone — no zero-copy transfer across the process boundary);
 *  reconstruct the Mat as
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
  | { type: "opened"; info: ViewerFileInfo; sidecar: SidecarLoad }
  | { type: "open-error"; message: string }
  | { type: "position"; positionNs: number; playing: boolean }
  | { type: "telemetry"; doc: PlaybackDoc }
  | { type: "descriptor"; topic: string; doc: PlaybackDoc }
  /** Live-stats reply to a `get-stats` request (keyed by channel topic). */
  | { type: "stats"; requestId: number; live: Record<string, StreamLiveStats> }
  | ViewerFrameEvent
  | { type: "error"; message: string };
