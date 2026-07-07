// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The `viewer` session contract — the PINNED CONTRACT shared by C-8 (the
// data layer, `@orchestrator/sessions/viewer`) and A-11 (the viewer window
// UI), spelled out verbatim in docs/refactor/split-of-work.md; the planner
// arbitrates any change. Kept in its own file (not `contracts.ts`) so the
// two concurrent threads never edit the same file. Renderer-safe and
// Vue-free, like every contract.
//
// Frames: published through the STANDARD frame transport under this
// session's namespace with frame name `<fileId>:<channel>` — i.e. wire topic
// `fr:viewer:<fileId>:<channel>` — so a viewer window consumes playback
// exactly like any live stream (`useSession(viewer, "viewer")
// .frame(`${fileId}:${channel}`)`: passive-capable subscribe, per-topic
// finterest, shm descriptors, OSD — nothing viewer-specific).
//
// Times: `durationNs` / `positionNs` / `seek.tNs` are nanoseconds RELATIVE
// to the file's first message (0 .. durationNs) — the natural scrub-bar
// domain; the absolute wall-clock anchor lives in the file's `fovea:session`
// metadata record if a UI ever wants it. Plain numbers, not bigints (2^53 ns
// ≈ 104 days — far beyond any recording).

import { cmd, defineContract, type Serializable } from "./protocol.js";

/** One replayed `telemetry`-channel document (parsed JSON). */
export type PlaybackDoc = Record<string, Serializable>;

/** One channel of an open container, as shown in the viewer's track list.
 *  `metadata` is the channel's MCAP metadata (the §2b static decode props —
 *  dtype/shape/pixelFormat/significantBits/channels — for `x-fovea-raw`
 *  channels) plus a `messageEncoding` key folded in so the UI can tell the
 *  `telemetry` (json) track from frame tracks without a second lookup. */
export type ViewerChannel = {
  name: string;
  metadata: Record<string, string>;
};

export type ViewerFile = {
  path: string;
  channels: ViewerChannel[];
  durationNs: number;
  positionNs: number;
  playing: boolean;
  /** True when the container had no MCAP footer (crash-truncated recording)
   *  and was opened through the streaming/re-index fallback — seeking works
   *  but is slower (sequential rescan), and `durationNs` reflects what was
   *  recovered, not what was intended. */
  truncated: boolean;
};

export const viewer = defineContract({
  state: {
    /** Every open container, keyed by fileId (server-assigned, opaque). */
    files: {} as Record<string, ViewerFile>,
  },
  telemetry: {
    /** Latest replayed `telemetry`-channel document per open file (the
     *  recorder's per-frame extras — volt/angle/affine), latest-wins at
     *  playback rate. Cleared to null on close. C-8 call, logged: state
     *  carries the static file inventory; the per-frame doc stream rides
     *  telemetry, mirroring how live sessions publish volt telemetry. */
    playback: {} as Record<string, PlaybackDoc | null>,
  },
  frames: [] as const, // all frame topics are dynamic: `<fileId>:<channel>`
  commands: {
    /** Open a `.fovea` container. Resolves once channels/duration are known
     *  (indexed read, or the streaming re-index fallback for footerless
     *  files). Does not start playback.
     *
     *  Idempotent per canonical (symlink-resolved) path: opening a path
     *  already open returns the existing `fileId` — no second reader,
     *  player, workload meter, or `<fileId>:<channel>` frame topics — per
     *  the one-window-per-file rule (the shell dedupes the window; the
     *  session dedupes resources, and a deduped open yields the same
     *  frame topics so a shared window sees one stream). `close(fileId)`
     *  releases it; there is no open refcount, so one `close` fully
     *  closes a deduped file. */
    open: cmd<string, { fileId: string }>(),
    /** Close one container: stops playback, releases the reader and the
     *  file's workload meter, removes it from `files`. */
    close: cmd<string, void>(),
    /** Jump to a position (ns, relative). While paused, republishes the
     *  latest frame at-or-before the target per frame channel so a scrub
     *  updates the display; while playing, playback resumes from there. */
    seek: cmd<{ fileId: string; tNs: number }, void>(),
    /** Start (or re-pace) timestamp-paced playback. `rate` multiplies
     *  wall-clock speed (1 = realtime); must be > 0. */
    play: cmd<{ fileId: string; rate: number }, void>(),
    pause: cmd<string, void>(),
  },
});

export type ViewerContract = typeof viewer;
