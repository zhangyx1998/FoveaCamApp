// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer↔engine wire protocol for the standalone viewer — window-local,
// renderer-safe, Node-free (types + string constants only).
// spec: docs/spec/viewer.md#protocol (topology: #topology)

import type { SidecarLoad, SidecarState } from "./sidecar.js";
import type { ExportRequest, ExportOverview } from "./export/types.js";

/** One channel of the open container, as shown in the viewer's track list.
 *  `metadata` is the channel's MCAP metadata (the static decode props for
 *  `x-fovea-raw` channels) plus a folded-in `messageEncoding` key so the UI
 *  can tell json (telemetry/descriptor) tracks from frame tracks. */
export type ViewerChannelInfo = {
  name: string;
  metadata: Record<string, string>;
  /** File-relative ns [startNs,lastNs] of this channel's FIRST and LAST
   *  message — the timeline block span. Absent when
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
  /** ABSOLUTE wall-clock epoch of the file's FIRST message, in milliseconds
   *  (the recording's start time). Feeds the property panel's absolute
   *  first/last message timestamps. Milliseconds — not
   *  ns — so it stays a safe JS integer; absolute epoch ns (~1.75e18) exceeds
   *  2^53. Optional: absent when the source can't supply it. */
  startEpochMs?: number;
  /** True when the container had no MCAP footer (crash-truncated recording)
   *  and was opened through the streaming re-index fallback. */
  truncated: boolean;
  /** True when the container carries a `fovea:wide-camera` metadata record —
   *  the recorder DECLARED a wide camera. Drives
   *  the "no wide designation" hint alongside master detection (the record is
   *  container-level intrinsics with no channel pointer, so the master CHANNEL
   *  is chosen by naming convention, not this flag). */
  wideCameraDeclared: boolean;
  /** ffmpeg was resolved (PATH + common Homebrew/MacPorts locations) by the
   *  engine — the export entry point is enabled iff true, else it shows the
   *  "ffmpeg not found" hint. */
  ffmpegAvailable: boolean;
  /** The `fovea:wide-camera` calibration parsed into a usable camera matrix +
   *  distortion — the undistort toggle is offerable for the WIDE/center stream
   *  only when true. */
  wideCalibrationAvailable: boolean;
  /** The recorded stereo baseline (mm) from the `fovea:wide-camera` metadata
   *  record's `baseline_mm` key. Feeds the footprint
   *  overlay's vergence-plane depth readout. Absent (null) on containers
   *  recorded before the baseline was written, or an uncalibrated rig — the
   *  depth hover then shows "—". */
  baselineMm: number | null;
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
  /** The set of frame channels the worker should DECODE: only ENABLED,
   *  displayed streams. The worker skips
   *  decode for channels absent here (still ingested + accounted as dropped);
   *  a newly-added channel triggers a seek-refresh of that channel at the
   *  current playhead so it repaints immediately while paused. `channels` is
   *  the `decodeSet()` shape — sorted, de-duplicated topic names. */
  | { type: "set-enabled"; channels: string[] }
  /** Persist viewer UI state to the sidecar. The worker debounces
   *  and writes `<path>.fcap.ui.json`; the `.fcap` stays read-only. */
  | { type: "save-ui"; state: SidecarState }
  /** Ask the engine for LIVE stats on `channels` (one tile — a merged pair
   *  sends both L/R). The reply is a `stats` event echoing `requestId` so a
   *  late reply for a since-closed/replaced popover is discarded. */
  | { type: "get-stats"; requestId: number; channels: string[] }
  /** Start a per-stream video export. The engine
   *  enqueues + dispatches per the parallel policy and streams `export-update`. */
  | { type: "export-start"; request: ExportRequest }
  /** Abort ONE export (tray): SIGKILL its ffmpeg + unlink the partial
   *  output if it was running; drop it from the queue if it was still queued. */
  | { type: "export-abort"; id: number }
  /** Abort EVERY queued+running export (window-close confirm). */
  | { type: "export-abort-all" }
  /** Drop terminal (done/failed/aborted) jobs from the tray snapshot ("Clear
   *  finished"). Running/queued jobs are untouched. */
  | { type: "export-clear-finished" }
  /** Global parallel-export policy — persisted renderer-side, pushed
   *  to the engine on change (and once at spawn). */
  | { type: "export-set-parallel"; parallel: boolean }
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
  /** Export queue snapshot for the title-bar tray — pushed on every
   *  enqueue / progress tick / completion / abort. */
  | { type: "export-update"; overview: ExportOverview }
  | ViewerFrameEvent
  | { type: "error"; message: string };
