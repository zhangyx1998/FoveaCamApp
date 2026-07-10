<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  STANDALONE recorder viewer window — multi-track correlation UI
  (viewer-timeline.md, built on standalone-viewer-and-fcap). Playback data
  (MCAP read + core-Vision decode + timestamp-paced playback) runs on a worker
  thread INSIDE this window's process (src/viewer/worker.ts); the orchestrator
  is never involved.

  Layout (rulings 3/6/9): an UPPER preview panel of tiles — every ENABLED
  stream whose block spans the playhead, in Z order (master track first, then
  top→bottom) — over a LOWER timeline panel of tracks/blocks (a read-only
  video-editor). A draggable divider splits them; the timeline collapses to an
  up-arrow drawer. Blocks drag between tracks (snap; collision refused), focus +
  `v` toggles a stream, a per-pair "3D View" dropdown merges L/R. ALL UI state
  persists to `<file>.fcap.ui.json` (worker-side, ruling 8/10/11); the `.fcap`
  is read-only. Pure model + algorithms live in src/viewer/timeline.ts and
  src/viewer/sidecar.ts (unit-tested); this component is the wiring + DOM.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { Mat } from "core/Vision";
import {
  type PlaybackDoc,
  type StreamLiveStats,
  type ViewerChannelInfo,
  type ViewerCommand,
  type ViewerEvent,
  type ViewerFileInfo,
} from "../viewer/protocol";
import {
  assembleEntityDetail,
  assembleStaticStats,
  clampPopover,
  formatDuration,
  formatFps,
  formatLive,
  formatPixelFormat,
  formatResolution,
  formatTimecode,
  type EntityDetail,
} from "../viewer/stats";
import StatsPopover, { type StatsEntry } from "../viewer/StatsPopover.vue";
import {
  activeChannels,
  composeTiles,
  decodeSet,
  detectMaster,
  detectPairs,
  dropCollides,
  initialLayout,
  layoutMismatch,
  moveBlock,
  nsAtClientX,
  reconcileLayout,
  sideOf,
  THREE_D_MODES,
  type ChannelBlock,
  type ThreeDMode,
  type Tile,
} from "../viewer/timeline";
import {
  COLLAPSED_SPLIT,
  DEFAULT_PANEL_WIDTH,
  DEFAULT_SPLIT,
  DEFAULT_TILE_WIDTH,
  MAX_PANEL_WIDTH,
  MAX_SPLIT,
  MAX_TILE_WIDTH,
  MIN_PANEL_WIDTH,
  MIN_SPLIT,
  MIN_TILE_WIDTH,
  type SidecarLoad,
  type SidecarState,
} from "../viewer/sidecar";
import { useConfigRef } from "@lib/config";
import {
  ANAGLYPH_CHANNELS,
  DEFAULT_ANAGLYPH_STYLE,
  type AnaglyphStyle,
} from "../../../docs/schema/anaglyph";
import TitleBar from "../components/TitleBar.vue";
import FrameView from "../components/FrameView.vue";
import ExportDialog from "../viewer/ExportDialog.vue";
import ExportTray from "../viewer/ExportTray.vue";
import type { ExportRequest, ExportOverview } from "../viewer/export/types";
import {
  initialBannerState,
  setActive as bannerSetActive,
  dismiss as bannerDismiss,
  bannerVisible,
} from "../viewer/export/banner";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faArrowsRotate,
  faChevronDown,
  faChevronUp,
  faFolderOpen,
  faTableColumns,
  faFileExport,
  faXmark,
  faPlay,
  faPause,
} from "../windows/icons";

const props = defineProps<{ path: string }>();

const titleBarHeight = ref(0);

// --- engine link (window-local playback state) ------------------------------
// The playback engine is a MAIN-owned utilityProcess (standalone-viewer-and-fcap
// AS SHIPPED amendment — a renderer can't host a Node worker). Main brokers a
// MessagePort back over `viewer:port`; we talk to the engine directly over it.

const file = ref<ViewerFileInfo | null>(null);
const openError = ref<string | null>(null);
const playing = ref(false);
const workerPositionNs = ref(0);
const descriptors = ref<Record<string, PlaybackDoc>>({});
/** Latest decoded Mat per frame channel — plain Map + a tick (frames arrive at
 *  playback rate; the tiles that actually changed re-render off the tick). */
const mats = new Map<string, Mat<Uint8Array>>();
const frameTick = ref(0);

let port: MessagePort | null = null;
function send(cmd: ViewerCommand): void {
  port?.postMessage(cmd);
}

function onEngineEvent(ev: ViewerEvent): void {
  switch (ev?.type) {
    case "opened":
      file.value = ev.info;
      applySidecar(ev.sidecar);
      // Seed the engine's parallel policy now the port is live (the config-load
      // send can race ahead of the port arriving).
      send({ type: "export-set-parallel", parallel: exportParallel.value });
      break;
    case "open-error":
      openError.value = ev.message;
      break;
    case "position":
      workerPositionNs.value = ev.positionNs;
      playing.value = ev.playing;
      break;
    case "telemetry":
      break; // per-frame extras — not surfaced yet
    case "descriptor":
      descriptors.value = { ...descriptors.value, [ev.topic]: ev.doc };
      break;
    case "stats":
      // Route the reply to whichever surface issued it (both share one request
      // counter so ids never collide). A late reply for a since-closed/replaced
      // surface matches neither current id and is discarded.
      if (ev.requestId === popoverReqId) liveStats.value = ev.live;
      else if (ev.requestId === panelReqId)
        panelLiveStats.value = { ...panelLiveStats.value, ...ev.live };
      break;
    case "frame": {
      const mat = Object.assign(new Uint8Array(ev.buffer, ev.byteOffset, ev.length), {
        shape: ev.shape,
        channels: ev.channels,
      }) as Mat<Uint8Array>;
      mats.set(ev.channel, mat);
      frameTick.value++;
      break;
    }
    case "export-update":
      onExportUpdate(ev.overview);
      break;
    case "error":
      console.error("[viewer]", ev.message);
      break;
  }
}

// --- video export (viewer-export.md) ---------------------------------------
const exportOverview = ref<ExportOverview>({ jobs: [], active: 0, overall: null });
const exportDialogChannel = ref<string | null>(null);
const confirmClose = ref(false);
// Global parallel-export policy (persisted; spec 10). Pushed to the engine on
// change + once the engine is up.
const exportParallel = ref(false);
void useConfigRef("export_parallel").then((r) => {
  exportParallel.value = !!r.value;
  watch(r, (v) => {
    exportParallel.value = !!v;
    send({ type: "export-set-parallel", parallel: !!v });
  });
  // Seed the engine once it exists (and immediately if it already does).
  send({ type: "export-set-parallel", parallel: !!r.value });
});
function setExportParallel(value: boolean): void {
  void useConfigRef("export_parallel").then((r) => (r.value = value));
}

let lastExportsActive = false;
function onExportUpdate(overview: ExportOverview): void {
  exportOverview.value = overview;
  // Tell main whether this window has queued/running exports (close-intercept),
  // on every 0-crossing only.
  const active = overview.active > 0;
  if (active !== lastExportsActive) {
    lastExportsActive = active;
    window.foveaBridge?.setViewerExportsActive?.(active);
  }
}

function openExportDialog(channel: string): void {
  exportDialogChannel.value = channel;
}
function submitExport(request: ExportRequest): void {
  send({ type: "export-start", request });
}
function abortExport(id: number): void {
  send({ type: "export-abort", id });
}

// Close intercept (spec 11): main asks to confirm aborting exports.
const disposeConfirmClose = window.foveaBridge?.onViewerConfirmClose?.(() => {
  confirmClose.value = true;
});
function confirmAbortAndClose(): void {
  send({ type: "export-abort-all" });
  confirmClose.value = false;
  window.foveaBridge?.confirmViewerClose?.();
}
function cancelClose(): void {
  confirmClose.value = false;
}

// --- live-capture banner (addendum) ----------------------------------------
const bannerState = ref(initialBannerState);
const showBanner = computed(() => bannerVisible(bannerState.value));
function dismissBanner(): void {
  bannerState.value = bannerDismiss(bannerState.value);
}
// Subscribe BEFORE the seed await (telecanvas:target pattern) so a change
// between seed + await isn't missed.
const disposeSession = window.foveaBridge?.onAppSessionActive?.((active) => {
  bannerState.value = bannerSetActive(bannerState.value, active);
});
void window.foveaBridge?.getAppSessionActive?.().then((active) => {
  bannerState.value = bannerSetActive(bannerState.value, active);
});

// Export availability for the focused stream's dialog.
const exportUndistortAvailable = computed(
  () =>
    !!file.value?.wideCalibrationAvailable &&
    // A DESIGNATED wide/center only: detectMaster falls back to the first
    // frame channel (designated:false) on recordings that never name one, and
    // applying the wide-camera calibration to an arbitrary (possibly fovea)
    // stream would silently mis-undistort it (UI/UX review 2026-07-10).
    master.value.designated &&
    exportDialogChannel.value != null &&
    exportDialogChannel.value === master.value.channel,
);
const exportUndistortReason = computed(() => {
  if (!file.value?.wideCalibrationAvailable)
    return "This recording carries no camera calibration";
  if (!master.value.designated)
    return "This recording does not designate a wide/center stream to bind the calibration to";
  return "Only the wide/center stream carries calibration (fovea streams use per-frame maps)";
});
const exportDialogStat = computed(() => {
  const ch = exportDialogChannel.value;
  if (!ch) return null;
  const info = frameChannelInfos.value.find((c) => c.name === ch);
  if (!info) return null;
  const stat = assembleStaticStats(info);
  // Default fps = the summary-derived rate (avgFps: (count-1)/span). The median-
  // of-deltas detector is applied in the engine's resample path; a per-stream
  // full timestamp scan at dialog-open is avoided (viewer-export AS-BUILT note).
  return { width: stat.width, height: stat.height, fps: stat.avgFps ?? 30 };
});

// Receive the brokered engine port from main (relayed by preload-viewer into the
// main world — a live port can't cross the bridge as a value). Mirrors the
// orchestrator-client `orchestrator:port` handshake.
function onViewerPort(e: MessageEvent): void {
  if (e.data !== "viewer:port") return;
  window.removeEventListener("message", onViewerPort);
  const p = e.ports[0];
  if (!p) return;
  port = p;
  p.onmessage = (m) => onEngineEvent(m.data as ViewerEvent);
  p.start();
}
window.addEventListener("message", onViewerPort);

// Engine crash (utilityProcess died) → surface an error instead of waiting for
// frames forever.
const disposeEngineDown = window.foveaBridge?.onViewerEngineDown?.((message) => {
  openError.value = message;
});

onMounted(() => {
  if (!props.path) {
    openError.value = "Missing file path (?path=…)";
    return;
  }
  // Ask main to fork this window's engine over the file; it opens eagerly and
  // the port arrives on `viewer:port`.
  window.foveaBridge?.spawnViewerEngine?.(props.path);
});

function onPageHide(): void {
  send({ type: "close" }); // best-effort early sidecar flush (main also flushes)
}
window.addEventListener("pagehide", onPageHide);
window.addEventListener("keydown", onKeydown);
window.addEventListener("pointerdown", onDocPointerDown, true);
onUnmounted(() => {
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("pointerdown", onDocPointerDown, true);
  window.removeEventListener("message", onViewerPort);
  closeStats();
  stopPanelPoll();
  disposeEngineDown?.();
  disposeConfirmClose?.();
  disposeSession?.();
});

const basename = computed(() => props.path.split(/[/\\]/).pop() ?? props.path);
const compactPath = computed(() =>
  props.path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, "~"),
);
function openFolder(): void {
  void window.foveaBridge?.revealRecording?.(props.path);
}

// --- channels / blocks / master / pairs ------------------------------------

const isVisual = (c: ViewerChannelInfo) => c.metadata.messageEncoding !== "json";
const frameChannelInfos = computed(() => (file.value?.channels ?? []).filter(isVisual));
const frameChannels = computed(() => frameChannelInfos.value.map((c) => c.name));
/** Blocks for frame channels that actually carried a message (a span). */
const blocks = computed<ChannelBlock[]>(() =>
  frameChannelInfos.value
    .filter((c) => c.startNs !== undefined && c.lastNs !== undefined)
    .map((c) => ({ channel: c.name, startNs: c.startNs!, lastNs: c.lastNs! })),
);
const blockByChannel = computed(() => new Map(blocks.value.map((b) => [b.channel, b])));
const master = computed(() => detectMaster(frameChannels.value));
const pairs = computed(() => detectPairs(frameChannels.value));

// --- persisted UI state (sidecar-backed, window-local) ----------------------

const tracks = ref<string[][]>([]); // full layout, row 0 = master track
const disabled = ref<Set<string>>(new Set());
// GLOBAL 3D view mode (ruling 4, amended user 2026-07-09): one mode for EVERY
// L/R pair, chosen in the preview header — no longer per pair.
const threeD = ref<ThreeDMode>("disabled");
const split = ref<number>(DEFAULT_SPLIT); // preview height fraction
const tileWidth = ref<number>(DEFAULT_TILE_WIDTH);
// Property panel (UI round 2 ruling 4) — persisted visibility + width.
const panelOpen = ref(false);
const panelWidth = ref<number>(DEFAULT_PANEL_WIDTH);
const initialized = ref(false);
/** Non-null while a confirm dialog is up (ruling 10 — corrupt/mismatch). */
const confirmReset = ref<null | { reason: "corrupt" | "mismatch" }>(null);

/** pair-membership lookup: channel → {pair, mode}. Every pair takes the SINGLE
 *  global mode (ruling 4 amendment); the tile/decode-set derivation is unchanged
 *  downstream — it just reads one mode for all pairs now. */
const pairModeOf = computed(() => {
  const m = new Map<string, { pair: (typeof pairs.value)[number]; mode: ThreeDMode }>();
  const mode = threeD.value;
  for (const p of pairs.value) {
    m.set(p.left, { pair: p, mode });
    m.set(p.right, { pair: p, mode });
  }
  return m;
});
/** True when the container has any L/R pair — gates the global 3D control. */
const hasPairs = computed(() => pairs.value.length > 0);

const enabledFrameChannels = computed(() => frameChannels.value.filter((c) => !disabled.value.has(c)));
const enabledSet = computed(() => new Set(enabledFrameChannels.value));

function currentSidecarState(): SidecarState {
  return {
    v: 1,
    tracks: tracks.value,
    disabled: [...disabled.value],
    threeD: threeD.value,
    split: split.value,
    tileWidth: tileWidth.value,
    playheadNs: workerPositionNs.value,
    panelOpen: panelOpen.value,
    panelWidth: panelWidth.value,
  };
}

/** Persist the current UI state (debounced write-through, worker-side). */
function persist(): void {
  if (!initialized.value || !file.value) return;
  send({ type: "save-ui", state: currentSidecarState() });
}

/** Seed a fresh layout + defaults (ruling 10: greedy fit runs ONLY here). */
function initializeLayout(persistIt: boolean): void {
  tracks.value = initialLayout(blocks.value, master.value.channel);
  disabled.value = new Set();
  threeD.value = "disabled";
  split.value = DEFAULT_SPLIT;
  tileWidth.value = DEFAULT_TILE_WIDTH;
  panelOpen.value = false;
  panelWidth.value = DEFAULT_PANEL_WIDTH;
  initialized.value = true;
  if (persistIt) persist();
}

function applySidecar(load: SidecarLoad): void {
  if (load.status === "absent") {
    // Nothing to lose — silently initialize + persist (ruling 10).
    initializeLayout(true);
    return;
  }
  if (load.status === "corrupt") {
    // Present but unreadable: use in-memory defaults WITHOUT overwriting; ask.
    initializeLayout(false);
    confirmReset.value = { reason: "corrupt" };
    return;
  }
  // status === "ok": restore. threeD/disabled/split/tileWidth apply regardless.
  const st = load.state;
  disabled.value = new Set(st.disabled);
  threeD.value = st.threeD; // global mode (sidecar already collapsed old maps)
  split.value = st.split;
  tileWidth.value = st.tileWidth;
  panelOpen.value = st.panelOpen;
  panelWidth.value = st.panelWidth;
  if (layoutMismatch(st.tracks, frameChannels.value)) {
    // Channels changed since last view: reconcile in-memory (don't discard),
    // and ask before overwriting (ruling 10).
    tracks.value = reconcileLayout(st.tracks, frameChannels.value);
    confirmReset.value = { reason: "mismatch" };
  } else {
    tracks.value = st.tracks.map((r) => [...r]);
  }
  initialized.value = true;
  if (st.playheadNs > 0) send({ type: "seek", tNs: st.playheadNs });
}

// Confirm-dialog resolutions.
function resetUiState(): void {
  initializeLayout(true);
  confirmReset.value = null;
}
function keepLayout(): void {
  // The user chose to keep their (reconciled) layout — persist it so the
  // now-present channels get saved positions going forward.
  confirmReset.value = null;
  persist();
}
function dismissConfirm(): void {
  // Corrupt "Not now": keep in-memory defaults, do NOT overwrite the file.
  confirmReset.value = null;
}

// --- worker decode gate (enabled-set, ruling 3) -----------------------------

const currentDecodeSet = computed(() => decodeSet(enabledFrameChannels.value, pairModeOf.value));
watch(
  currentDecodeSet,
  (set) => {
    if (file.value) send({ type: "set-enabled", channels: set });
  },
  { flush: "post" },
);

// --- playhead / transport ---------------------------------------------------

const RATES = [0.25, 0.5, 1, 2, 4];
// Keyboard seek steps (arrow keys): a ~30fps frame nudge, or a 1 s jump with
// Shift. Time-based (the viewer has no single canonical frame period across
// multiplexed streams), which matches the scrub model.
const NUDGE_STEP_NS = Math.round(1e9 / 30);
const SEEK_STEP_NS = 1e9;
const rate = ref(1);
const scrubbing = ref(false);
const scrubNs = ref(0);
const positionNs = computed(() => (scrubbing.value ? scrubNs.value : workerPositionNs.value));
const durationNs = computed(() => file.value?.durationNs ?? 0);

function togglePlay(): void {
  if (!file.value) return;
  if (playing.value) {
    send({ type: "pause" });
    persist(); // capture the paused playhead
  } else send({ type: "play", rate: rate.value });
}
function setRate(event: Event): void {
  rate.value = Number((event.target as HTMLSelectElement).value);
  if (playing.value) send({ type: "play", rate: rate.value });
}
function seekTo(tNs: number): void {
  const clamped = Math.min(Math.max(0, tNs), durationNs.value);
  scrubbing.value = true;
  scrubNs.value = clamped;
  descriptors.value = {}; // reset-on-seek: no future bbox left on screen
  send({ type: "seek", tNs: clamped });
}
/** Click-to-seek on a timeline track lane (snap). Shares `nsAtClientX` with the
 *  draggable playhead so both map pointer x → time identically. */
function seekFromClientX(clientX: number, el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  seekTo(nsAtClientX(clientX, r.left, r.width, durationNs.value));
  scrubbing.value = false;
}

// --- draggable playhead (UI round 2 ruling 1) -------------------------------
// The playhead line itself drags along the timeline (no separate scrub input);
// its hit strip is wider than the 1px line (see `.playhead` in the styles). We
// map against the TRACKS element rect so the mapping matches lane click-seek.
const tracksEl = ref<HTMLElement | null>(null);
const playheadDrag = ref(false);
function onPlayheadDown(e: PointerEvent): void {
  if (e.button !== 0 || !tracksEl.value) return;
  e.stopPropagation(); // don't let the lane under it also seek
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  playheadDrag.value = true;
  const r = tracksEl.value.getBoundingClientRect();
  seekTo(nsAtClientX(e.clientX, r.left, r.width, durationNs.value));
}
function onPlayheadMove(e: PointerEvent): void {
  if (!playheadDrag.value || !tracksEl.value) return;
  const r = tracksEl.value.getBoundingClientRect();
  seekTo(nsAtClientX(e.clientX, r.left, r.width, durationNs.value));
}
function onPlayheadUp(): void {
  if (!playheadDrag.value) return;
  playheadDrag.value = false;
  scrubbing.value = false;
  persist();
}

// --- preview tiles ----------------------------------------------------------

const orderedActive = computed(() =>
  activeChannels(tracks.value, blocks.value, positionNs.value, enabledSet.value),
);
const tiles = computed<Tile[]>(() => composeTiles(orderedActive.value, pairModeOf.value));

/** The configured anaglyph style (app config `anaglyph_style`) — drives the 3D
 *  compose below. Live: a Settings change flows through the shared config doc.
 *  Non-blocking with the RC default until it resolves; if this window is opened
 *  without an orchestrator (fully standalone), the read never resolves and the
 *  default stands (view-time choice — no file-format impact). */
const anaglyphStyle = ref<AnaglyphStyle>(DEFAULT_ANAGLYPH_STYLE);
void useConfigRef("anaglyph_style").then((r) => {
  anaglyphStyle.value = r.value ?? DEFAULT_ANAGLYPH_STYLE;
  watch(r, (v) => (anaglyphStyle.value = v ?? DEFAULT_ANAGLYPH_STYLE));
});

/** Anaglyph compose per the configured STYLE (docs/schema/anaglyph — the same
 *  channel table the native CompositeStream brick + the Settings cards read, so
 *  live disparity-scope and viewer playback match). Each output RGB channel is
 *  sourced from the LEFT frame, the RIGHT frame, or forced 0 per the style map;
 *  grayscale (1ch) sources broadcast. Merged renderer-side into a fresh
 *  3-channel RGB Mat (no core dependency, ruling 4). Uses the min of the two
 *  frames' dims when they differ. */
function anaglyph(
  l: Mat<Uint8Array>,
  r: Mat<Uint8Array>,
  style: AnaglyphStyle,
): Mat<Uint8Array> {
  const map = ANAGLYPH_CHANNELS[style];
  const H = Math.min(l.shape[0] ?? 0, r.shape[0] ?? 0);
  const W = Math.min(l.shape[1] ?? 0, r.shape[1] ?? 0);
  const lw = l.shape[1] ?? W;
  const rw = r.shape[1] ?? W;
  const lc = l.channels;
  const rc = r.channels;
  const out = new Uint8Array(H * W * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const li = (y * lw + x) * lc;
      const ri = (y * rw + x) * rc;
      const oi = (y * W + x) * 3;
      // Per output channel (0 = R, 1 = G, 2 = B): the style names which eye
      // sources it; grayscale sources broadcast their single channel.
      for (let ch = 0; ch < 3; ch++) {
        const src = ch === 0 ? map.r : ch === 1 ? map.g : map.b;
        out[oi + ch] =
          src === "left"
            ? lc === 1
              ? l[li]!
              : l[li + ch]!
            : src === "right"
              ? rc === 1
                ? r[ri]!
                : r[ri + ch]!
              : 0;
      }
    }
  }
  return Object.assign(out, { shape: [H, W, 3], channels: 3 }) as Mat<Uint8Array>;
}

/** The Mat a tile renders (reads `frameTick` so tiles re-render on new frames).
 *  null → the block spans the playhead but no frame decoded yet: placeholder. */
function tileMat(tile: Tile): Mat<Uint8Array> | null {
  void frameTick.value;
  if (tile.kind === "single") return mats.get(tile.channel) ?? null;
  const { pair, mode } = tile;
  if (mode === "left-only") return mats.get(pair.left) ?? null;
  if (mode === "right-only") return mats.get(pair.right) ?? null;
  const l = mats.get(pair.left);
  const r = mats.get(pair.right);
  if (!l || !r) return l ?? r ?? null; // one side missing → show what we have
  return anaglyph(l, r, anaglyphStyle.value); // .value tracked → recompose on style change
}
function tileKey(tile: Tile): string {
  return tile.kind === "single" ? tile.channel : `pair:${tile.pair.base}`;
}
function tileLabel(tile: Tile): string {
  if (tile.kind === "single") return tile.channel;
  const m = tile.mode === "anaglyph" ? "3D" : tile.mode === "left-only" ? "L" : "R";
  return `${tile.pair.base} (${m})`;
}

// --- stream stats popover (right-click a tile / timeline block) -------------
// Right-click opens a compact in-window popover of stream stats. The STATIC
// half is assembled renderer-side from the already-open channel info (shows
// instantly); the LIVE half rides a get-stats→stats request and refreshes while
// the popover stays open. One popover at a time (design-language: instant,
// snap, layout-stable — the box never resizes when the live reply lands).
// One monotonic request counter shared by the popover and the property panel so
// their reply ids never collide; each surface remembers the last id it issued
// (the `stats` event routes on those — see onEngineEvent).
let nextStatsReq = 0;
let popoverReqId = -1;
let panelReqId = -1;
let statsPollTimer: ReturnType<typeof setInterval> | null = null;
const liveStats = ref<Record<string, StreamLiveStats>>({});
/** Live-stats for the property panel's focused channel (separate from the
 *  popover's map so the two surfaces never clobber each other). */
const panelLiveStats = ref<Record<string, StreamLiveStats>>({});
let panelPollTimer: ReturnType<typeof setInterval> | null = null;
const statsPopover = ref<null | {
  x: number;
  y: number;
  channels: string[]; // one (single tile) or [left, right] (merged pair)
  labels: string[]; // "" for a single; "L"/"R" for a pair
  is3D: boolean;
}>(null);

/** name → channel info, for the popover's static-stat assembly. */
const channelInfoByName = computed(
  () => new Map((file.value?.channels ?? []).map((c) => [c.name, c])),
);

/** The popover sections (static stats + latest live snapshot per side). */
const statsEntries = computed<StatsEntry[]>(() => {
  const pop = statsPopover.value;
  if (!pop) return [];
  return pop.channels.map((ch, i) => {
    const info = channelInfoByName.value.get(ch);
    return {
      label: pop.labels[i] ?? "",
      stat: info
        ? assembleStaticStats(info)
        : {
            name: ch, pixelFormat: "", significantBits: 0, codec: null,
            width: 0, height: 0, channels: 1, messageCount: null, spanNs: 0, avgFps: null,
          },
      live: liveStats.value[ch] ?? null,
    };
  });
});
/** Global 3D mode label, shown only when the popover targets a merged pair. */
const statsThreeDLabel = computed(() => (statsPopover.value?.is3D ? threeD.value : null));
/** Enabled-state of the popover's stream (any side enabled → enabled). */
const statsEnabled = computed(
  () => statsPopover.value?.channels.some((c) => !disabled.value.has(c)) ?? false,
);

function requestStats(channels: string[]): void {
  popoverReqId = ++nextStatsReq;
  send({ type: "get-stats", requestId: popoverReqId, channels });
}
function openStats(channels: string[], labels: string[], is3D: boolean, cx: number, cy: number): void {
  liveStats.value = {}; // clear stale live rows → placeholders until the reply
  // Clamp against the window with a nominal size so the box never spills off.
  const { x, y } = clampPopover(
    cx, cy, 280, 150 + channels.length * 130, window.innerWidth, window.innerHeight,
  );
  statsPopover.value = { x, y, channels, labels, is3D };
  requestStats(channels);
  if (statsPollTimer) clearInterval(statsPollTimer);
  statsPollTimer = setInterval(() => requestStats(channels), 500);
}
function onTileContextMenu(e: MouseEvent, tile: Tile): void {
  e.preventDefault();
  if (tile.kind === "single") openStats([tile.channel], [""], false, e.clientX, e.clientY);
  else openStats([tile.pair.left, tile.pair.right], ["L", "R"], true, e.clientX, e.clientY);
}
/** Right-click a timeline block → the SAME popover for that stream (a paired
 *  member under a non-disabled 3D mode opens the merged L/R view). */
function onBlockContextMenu(e: MouseEvent, channel: string): void {
  e.preventDefault();
  const info = pairModeOf.value.get(channel);
  if (info && info.mode !== "disabled")
    openStats([info.pair.left, info.pair.right], ["L", "R"], true, e.clientX, e.clientY);
  else openStats([channel], [""], false, e.clientX, e.clientY);
}
function closeStats(): void {
  if (!statsPopover.value) return;
  statsPopover.value = null;
  if (statsPollTimer) {
    clearInterval(statsPollTimer);
    statsPollTimer = null;
  }
}
/** Dismiss on any pointerdown outside the popover (a right-click on another
 *  tile fires pointerdown → close → its contextmenu reopens for that tile). */
function onDocPointerDown(e: PointerEvent): void {
  if (!statsPopover.value) return;
  const t = e.target as HTMLElement | null;
  if (t && t.closest(".stats-popover")) return;
  closeStats();
}

// --- descriptor overlay (multi-fovea, drawn on the master/center tile) -------
const TARGET_COLORS = [
  "#00aaff", "#ffb000", "#36d16f", "#ff5b8a",
  "#b983ff", "#00d5c7", "#ff7a35", "#d6e04f",
];
type OverlayBox = { topic: string; index: number; bbox: { x: number; y: number; width: number; height: number } };
function overlayBoxesFor(channel: string): OverlayBox[] {
  if (channel !== master.value.channel || master.value.channel !== "center") return [];
  const out: OverlayBox[] = [];
  for (const [topic, doc] of Object.entries(descriptors.value)) {
    const bbox = (doc as { bbox?: OverlayBox["bbox"] }).bbox;
    if (!bbox || typeof bbox.x !== "number") continue;
    const index = Number(topic.split("/").pop());
    out.push({ topic, index: Number.isFinite(index) ? index : 0, bbox });
  }
  return out;
}

// --- timeline geometry ------------------------------------------------------

function blockStyle(channel: string): Record<string, string> {
  const b = blockByChannel.value.get(channel);
  const d = durationNs.value;
  if (!b || d <= 0) return { display: "none" };
  const left = (b.startNs / d) * 100;
  const width = Math.max(0.4, ((b.lastNs - b.startNs) / d) * 100);
  return { left: `${left}%`, width: `${width}%` };
}
const playheadPct = computed(() => {
  const d = durationNs.value;
  return d > 0 ? (positionNs.value / d) * 100 : 0;
});
const isMasterChannel = (channel: string) => channel === master.value.channel;
/** Set the single GLOBAL 3D mode (ruling 4 amendment) — applies to every pair. */
function setThreeDMode(event: Event): void {
  threeD.value = (event.target as HTMLSelectElement).value as ThreeDMode;
  persist();
}

// --- v-toggle (ruling 5): focused block + `v` toggles the stream ------------
const focused = ref<string | null>(null);
function focusBlock(channel: string): void {
  focused.value = channel;
}
/** Focus a preview tile's stream (its primary channel) — a merged pair focuses
 *  its left eye, which is what the property panel + `v` act on. */
function focusTile(tile: Tile): void {
  focused.value = tile.channels[0] ?? null;
}

// --- cross-highlighting (UI round 2 ruling 5) -------------------------------
// Hovering OR focusing a track block highlights its preview tile, and vice
// versa — one shared highlight set keyed by stream id. Instant on/off; the
// treatment is outline/box-shadow only (never a layout-changing border).
const hoverChannels = ref<Set<string>>(new Set());
function setHover(channels: string[]): void {
  hoverChannels.value = new Set(channels);
}
function clearHover(): void {
  if (hoverChannels.value.size) hoverChannels.value = new Set();
}
const highlightChannels = computed<Set<string>>(() => {
  const s = new Set(hoverChannels.value);
  if (focused.value) s.add(focused.value);
  return s;
});
const blockHighlighted = (channel: string): boolean => highlightChannels.value.has(channel);
const tileHighlighted = (tile: Tile): boolean =>
  tile.channels.some((c) => highlightChannels.value.has(c));
const tileFocused = (tile: Tile): boolean =>
  focused.value != null && tile.channels.includes(focused.value);
function toggleDisabled(channel: string): void {
  const next = new Set(disabled.value);
  if (next.has(channel)) next.delete(channel);
  else next.add(channel);
  disabled.value = next;
  persist();
}
function onKeydown(e: KeyboardEvent): void {
  // --- Escape dismisses the TOPMOST dismissible surface (instant, and BEFORE the
  // text-entry/modifier guards so it fires even from a focused field inside the
  // export dialog). It never aborts a running export — the non-destructive
  // choice ("Keep open"/"Keep mine"/"Not now") is what Escape resolves to.
  // Priority: confirm modals > export dialog > stats popover. ---
  if (e.key === "Escape") {
    if (confirmClose.value) {
      e.preventDefault();
      cancelClose(); // keep the window (and its exports) open
      return;
    }
    if (confirmReset.value) {
      e.preventDefault();
      // Non-destructive resolution: keep the reconciled layout on a mismatch,
      // keep in-memory defaults (no overwrite) on a corrupt sidecar.
      if (confirmReset.value.reason === "mismatch") keepLayout();
      else dismissConfirm();
      return;
    }
    if (exportDialogChannel.value) {
      e.preventDefault();
      exportDialogChannel.value = null;
      return;
    }
    if (statsPopover.value) {
      e.preventDefault();
      closeStats();
      return;
    }
    return;
  }
  // Window-local; ignore modifier chords (Cmd+V etc.) and text-entry targets so
  // we don't collide with menu accelerators or the rate <select>.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  if (e.key === "v" && focused.value) {
    e.preventDefault();
    toggleDisabled(focused.value);
    return;
  }
  // --- Transport shortcuts (only meaningful once a file is open). Space toggles
  // play/pause; ←/→ frame-nudge the playhead, playing or paused (Shift = larger
  // jump). These are the universal player conventions, previously
  // undiscoverable here. ---
  if (!file.value) return;
  if (e.key === " ") {
    // A focused button (e.g. the play control itself) already toggles on its
    // own native space-activation — don't double-fire.
    if (t?.tagName === "BUTTON") return;
    e.preventDefault();
    togglePlay();
    return;
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    // Accumulate across key-repeat: keep `scrubbing` LATCHED through the burst
    // (positionNs then reads scrubNs, so each press steps from the previous
    // press, not from a stale worker echo — rapid presses used to collapse to
    // ~1 frame; UI/UX review 2026-07-10). Debounced release settles back onto
    // the worker position and persists once per burst.
    seekTo(positionNs.value + dir * (e.shiftKey ? SEEK_STEP_NS : NUDGE_STEP_NS));
    if (nudgeSettle) clearTimeout(nudgeSettle);
    nudgeSettle = setTimeout(() => {
      nudgeSettle = null;
      scrubbing.value = false;
      persist();
    }, 200);
  }
}
/** Pending debounced release of the arrow-nudge scrub latch. */
let nudgeSettle: ReturnType<typeof setTimeout> | null = null;

// --- block drag/drop (ruling 2/10: snap; collision refused) -----------------
type DragState = {
  channel: string;
  pointerId: number;
  y: number; // current pointer clientY
  targetRow: number; // hovered row (or tracks.length for a new bottom row)
  colliding: boolean;
};
const drag = ref<DragState | null>(null);
const trackLaneEls = ref<HTMLElement[]>([]);
function registerLane(el: Element | null, row: number): void {
  if (el instanceof HTMLElement) trackLaneEls.value[row] = el;
}

function rowAtClientY(clientY: number): number {
  const lanes = trackLaneEls.value;
  for (let i = 0; i < lanes.length; i++) {
    const el = lanes[i];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom) return i;
  }
  // Below the last lane → a NEW bottom row.
  return tracks.value.length;
}

function onBlockPointerDown(e: PointerEvent, channel: string): void {
  if (e.button !== 0) return;
  focusBlock(channel);
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  drag.value = { channel, pointerId: e.pointerId, y: e.clientY, targetRow: -1, colliding: false };
}
function onBlockPointerMove(e: PointerEvent): void {
  const d = drag.value;
  if (!d || e.pointerId !== d.pointerId) return;
  const row = rowAtClientY(e.clientY);
  d.y = e.clientY;
  d.targetRow = row;
  d.colliding = dropCollides(tracks.value, blocks.value, d.channel, row);
  drag.value = { ...d };
}
function onBlockPointerUp(e: PointerEvent): void {
  const d = drag.value;
  if (!d || e.pointerId !== d.pointerId) return;
  drag.value = null;
  const currentRow = tracks.value.findIndex((r) => r.includes(d.channel));
  // Snap back (no-op) on collision or a drop onto the same row.
  if (d.targetRow < 0 || d.targetRow === currentRow || d.colliding) return;
  tracks.value = moveBlock(tracks.value, blocks.value, d.channel, d.targetRow);
  persist();
}

// --- divider drag (ruling 6: snap; min preview height; collapse drawer) ------
const dividerDrag = ref(false);
const mainEl = ref<HTMLElement | null>(null);
function onDividerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dividerDrag.value = true;
}
function onDividerMove(e: PointerEvent): void {
  if (!dividerDrag.value || !mainEl.value) return;
  const r = mainEl.value.getBoundingClientRect();
  if (r.height <= 0) return;
  const frac = (e.clientY - r.top) / r.height;
  split.value = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, frac));
}
function onDividerUp(): void {
  if (!dividerDrag.value) return;
  dividerDrag.value = false;
  persist();
}
const timelineCollapsed = computed(() => split.value <= COLLAPSED_SPLIT);
function collapseTimeline(): void {
  split.value = COLLAPSED_SPLIT;
  persist();
}
function expandTimeline(): void {
  split.value = DEFAULT_SPLIT;
  persist();
}
/** The transport bar's collapse/expand chevron (UI round 2 ruling 3) — the bar
 *  stays visible either way, so this just folds the tracks below it away. */
function toggleCollapse(): void {
  if (timelineCollapsed.value) expandTimeline();
  else collapseTimeline();
}
const previewFlex = computed(() =>
  timelineCollapsed.value ? "1 1 auto" : `0 0 ${(split.value * 100).toFixed(2)}%`,
);

// --- tile width (ruling 7) --------------------------------------------------
function onTileWidth(e: Event): void {
  tileWidth.value = Math.min(MAX_TILE_WIDTH, Math.max(MIN_TILE_WIDTH, Number((e.target as HTMLInputElement).value)));
}
function onTileWidthCommit(): void {
  persist();
}

// --- property panel (UI round 2 ruling 4) -----------------------------------
// A right-side inspector of the FOCUSED stream: the popover's static+live stats
// (reused via stats.ts) PLUS timeline/topology context. Toggle + width persist
// to the sidecar. When nothing is focused it shows a dim placeholder.
function togglePanel(): void {
  panelOpen.value = !panelOpen.value;
  persist();
}
/** Row index (0 = master) the focused channel sits on, or null when unplaced. */
function trackOf(channel: string): number | null {
  const i = tracks.value.findIndex((r) => r.includes(channel));
  return i >= 0 ? i : null;
}
/** Full inspector detail for the focused stream (null when nothing focused or
 *  the channel isn't in the open container). Reuses the pure assembler. */
const focusedDetail = computed<EntityDetail | null>(() => {
  const ch = focused.value;
  if (!ch) return null;
  const info = channelInfoByName.value.get(ch);
  if (!info) return null;
  const s = sideOf(ch);
  const paired = pairModeOf.value.get(ch);
  return assembleEntityDetail(info, {
    startEpochMs: file.value?.startEpochMs ?? null,
    track: trackOf(ch),
    isMaster: isMasterChannel(ch),
    side: s?.side ?? null,
    pairBase: paired?.pair.base ?? null,
    enabled: !disabled.value.has(ch),
  });
});
/** Latest live snapshot for the focused stream (panel half — separate poll). */
const focusedLive = computed(() =>
  focused.value ? (panelLiveStats.value[focused.value] ?? null) : null,
);
/** 3D mode shown in the panel only when the focused stream is paired. */
const focusedThreeD = computed(() => (focusedDetail.value?.pairBase ? threeD.value : null));

function requestPanelStats(channel: string): void {
  panelReqId = ++nextStatsReq;
  send({ type: "get-stats", requestId: panelReqId, channels: [channel] });
}
function stopPanelPoll(): void {
  if (panelPollTimer) {
    clearInterval(panelPollTimer);
    panelPollTimer = null;
  }
}
/** Keep the panel's live half fresh: (re)start a poll whenever the panel is
 *  open with a focused stream; stop it otherwise. */
watch(
  [panelOpen, focused, file],
  () => {
    stopPanelPoll();
    const ch = focused.value;
    if (!panelOpen.value || !ch || !file.value) return;
    panelLiveStats.value = {}; // placeholders until the reply lands
    requestPanelStats(ch);
    panelPollTimer = setInterval(() => requestPanelStats(ch), 500);
  },
  { flush: "post" },
);

/** Local wall-clock `HH:MM:SS.sss` for an absolute epoch ms (panel absolute
 *  timestamps); "—" when unknown. */
function fmtClock(epochMs: number | null): string {
  if (epochMs == null) return "—";
  const d = new Date(epochMs);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}
/** Signed offset of a file-relative ns from the current playhead ("+2.1 s"). */
function fmtRelToPlayhead(ns: number | null): string {
  if (ns == null) return "—";
  const d = ns - positionNs.value;
  return `${d >= 0 ? "+" : "−"}${formatDuration(Math.abs(d))}`;
}

// --- property panel resize (drag its left edge) -----------------------------
const previewAreaEl = ref<HTMLElement | null>(null);
const panelResizing = ref(false);
function onPanelResizeDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  panelResizing.value = true;
}
function onPanelResizeMove(e: PointerEvent): void {
  if (!panelResizing.value || !previewAreaEl.value) return;
  const r = previewAreaEl.value.getBoundingClientRect();
  panelWidth.value = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, r.right - e.clientX));
}
function onPanelResizeUp(): void {
  if (!panelResizing.value) return;
  panelResizing.value = false;
  persist();
}
</script>

<template>
  <div ref="mainEl" class="main" :style="{ top: titleBarHeight + 'px' }">
    <!-- Live-capture warning banner (viewer-export addendum): layout-stable
         (pushes content down, no overlay), instant (no slide), dismissable. -->
    <div v-if="showBanner" class="session-banner">
      <span class="msg">A live capture session is running — viewer playback and export may be degraded.</span>
      <button class="dismiss" title="Dismiss" @click="dismissBanner"><Icon :icon="faXmark" /></button>
    </div>
    <div v-if="openError" class="notice">{{ openError }}</div>
    <div v-else-if="!file" class="notice">Opening {{ basename }}…</div>
    <template v-else>
      <!-- ===== PREVIEW AREA: tile strip + optional property panel ===== -->
      <div ref="previewAreaEl" class="preview-area" :style="{ flex: previewFlex }">
        <section class="preview">
          <header class="preview-head">
            <span class="count">{{ tiles.length }} view{{ tiles.length === 1 ? "" : "s" }}</span>
            <span v-if="!master.designated" class="hint" title="No wide/center stream designated by the recorder — master is the first frame channel">
              no wide designation
            </span>
            <div class="head-controls">
              <label class="tilew" title="Tile width">
                <span>tile</span>
                <input
                  type="range"
                  :min="MIN_TILE_WIDTH"
                  :max="MAX_TILE_WIDTH"
                  :value="tileWidth"
                  @input="onTileWidth"
                  @change="onTileWidthCommit"
                />
              </label>
            </div>
          </header>
        <div class="tiles">
          <div
            v-for="tile in tiles"
            :key="tileKey(tile)"
            class="tile"
            :class="{
              highlight: tileHighlighted(tile),
              focused: tileFocused(tile),
            }"
            :style="{ width: tileWidth + 'px' }"
            tabindex="0"
            title="Click to focus · right-click for stream stats"
            @pointerenter="setHover(tile.channels)"
            @pointerleave="clearHover"
            @focus="focusTile(tile)"
            @click="focusTile(tile)"
            @contextmenu="onTileContextMenu($event, tile)"
          >
            <div class="tile-head">
              <span class="tile-name" :class="{ master: tile.kind === 'single' && isMasterChannel(tile.channel) }">
                {{ tileLabel(tile) }}
              </span>
            </div>
            <div class="tile-body">
              <FrameView v-if="tileMat(tile)" :mat="tileMat(tile)!" width="100%" height="100%">
                <template v-if="tile.kind === 'single'">
                  <g v-for="box in overlayBoxesFor(tile.channel)" :key="box.topic">
                    <rect
                      :x="box.bbox.x" :y="box.bbox.y" :width="box.bbox.width" :height="box.bbox.height"
                      :stroke="TARGET_COLORS[box.index % TARGET_COLORS.length]" stroke-width="3" fill="none"
                    />
                  </g>
                </template>
              </FrameView>
              <div v-else class="tile-placeholder" title="This stream spans the playhead but no frame has decoded here yet — play or scrub">
                waiting for frame…
              </div>
            </div>
          </div>
          <div v-if="tiles.length === 0" class="notice">
            No enabled stream under the playhead — press play or scrub.
          </div>
          </div>
        </section>

        <!-- ===== PROPERTY PANEL (focused-stream inspector, ruling 4) ===== -->
        <aside v-if="panelOpen" class="property-panel" :style="{ width: panelWidth + 'px' }">
          <div
            class="panel-resize"
            title="Resize panel"
            @pointerdown="onPanelResizeDown"
            @pointermove="onPanelResizeMove"
            @pointerup="onPanelResizeUp"
            @pointercancel="onPanelResizeUp"
          />
          <template v-if="focusedDetail">
            <div class="panel-head">
              <span class="panel-name">{{ focusedDetail.name }}</span>
              <span class="panel-state" :class="{ off: !focusedDetail.enabled }">
                {{ focusedDetail.enabled ? "enabled" : "disabled" }}
              </span>
              <button
                v-if="frameChannels.includes(focusedDetail.name)"
                class="panel-export"
                :title="file?.ffmpegAvailable ? 'Export this stream to video' : 'ffmpeg not found — install ffmpeg to enable video export'"
                @click="openExportDialog(focusedDetail.name)"
              >
                <Icon :icon="faFileExport" /> Export…
              </button>
            </div>
            <dl class="panel-rows">
              <div class="row"><dt>channel</dt><dd>{{ focusedDetail.name }}</dd></div>
              <div class="row"><dt>encoding</dt><dd>{{ focusedDetail.encoding || "—" }}</dd></div>
              <div class="row"><dt>format</dt><dd>{{ formatPixelFormat(focusedDetail.stat) }}</dd></div>
              <div class="row">
                <dt>resolution</dt>
                <dd>{{ formatResolution(focusedDetail.stat.width, focusedDetail.stat.height) }}<span class="sub">×{{ focusedDetail.stat.channels }}ch</span></dd>
              </div>
              <div class="row"><dt>messages</dt><dd>{{ focusedDetail.stat.messageCount ?? "—" }}<span class="sub"> · {{ formatFps(focusedDetail.stat.avgFps) }} avg</span></dd></div>
              <div class="row"><dt>span</dt><dd>{{ formatDuration(focusedDetail.spanNs) }}</dd></div>

              <div class="group">timestamps</div>
              <div class="row"><dt>first</dt><dd>{{ fmtClock(focusedDetail.firstEpochMs) }}<span class="sub"> · {{ formatTimecode(focusedDetail.firstNs ?? 0) }}</span></dd></div>
              <div class="row"><dt></dt><dd class="sub">{{ fmtRelToPlayhead(focusedDetail.firstNs) }} vs playhead</dd></div>
              <div class="row"><dt>last</dt><dd>{{ fmtClock(focusedDetail.lastEpochMs) }}<span class="sub"> · {{ formatTimecode(focusedDetail.lastNs ?? 0) }}</span></dd></div>
              <div class="row"><dt></dt><dd class="sub">{{ fmtRelToPlayhead(focusedDetail.lastNs) }} vs playhead</dd></div>

              <div class="group">live</div>
              <div class="row live"><dt>decoded</dt><dd>{{ formatLive(focusedLive).decoded }}</dd></div>
              <div class="row live"><dt>rate</dt><dd>{{ formatLive(focusedLive).rate }}</dd></div>
              <div class="row live"><dt>frame</dt><dd>{{ formatLive(focusedLive).lastFrame }}<span class="sub"> · {{ fmtRelToPlayhead(focusedLive?.lastFrameNs ?? null) }}</span></dd></div>

              <div class="group">layout</div>
              <div class="row"><dt>track</dt><dd>{{ focusedDetail.track == null ? "—" : (focusedDetail.track === 0 ? "master" : focusedDetail.track) }}</dd></div>
              <div class="row"><dt>enabled</dt><dd>{{ focusedDetail.enabled ? "yes" : "no" }}</dd></div>
              <div v-if="focusedDetail.pairBase" class="row"><dt>pair</dt><dd>{{ focusedDetail.pairBase }}<span class="sub"> · {{ focusedDetail.side }}</span></dd></div>
              <div v-if="focusedThreeD" class="row"><dt>3D mode</dt><dd>{{ focusedThreeD }}</dd></div>
            </dl>
          </template>
          <div v-else class="panel-empty">Select a stream to inspect</div>
        </aside>
      </div>

      <!-- ===== TRANSPORT BAR (the draggable divider, ruling 3) =====
           The bar itself is the resize drag handle (pointer drag = split);
           the LEFT / RIGHT control clusters are interactive islands
           (`@pointerdown.stop`) so their buttons never start a drag — same
           pattern as TitleBar's draggable strips + no-drag slot. -->
      <div
        class="transport-bar"
        :class="{ dragging: dividerDrag }"
        @pointerdown="onDividerDown"
        @pointermove="onDividerMove"
        @pointerup="onDividerUp"
        @pointercancel="onDividerUp"
      >
        <div class="bar-group left" @pointerdown.stop>
          <button class="play" @click="togglePlay" :title="playing ? 'Pause (Space)' : 'Play (Space)'" :aria-label="playing ? 'Pause' : 'Play'">
            <Icon :icon="playing ? faPause : faPlay" />
          </button>
          <select :value="rate" @change="setRate" title="Playback rate">
            <option v-for="r in RATES" :key="r" :value="r">{{ r }}×</option>
          </select>
        </div>
        <div class="bar-group center">
          <span class="timecode" title="Playhead · total (← → to step, Shift for 1 s)">
            {{ formatTimecode(positionNs) }}<span class="sep"> / </span><span class="total">{{ formatTimecode(durationNs) }}</span>
          </span>
        </div>
        <div class="bar-group right" @pointerdown.stop>
          <label v-if="hasPairs" class="threed-global" title="3D View — applies to every L/R pair">
            <span>3D</span>
            <select :value="threeD" @change="setThreeDMode">
              <option v-for="m in THREE_D_MODES" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
          <button class="bar-btn" :class="{ active: panelOpen }" @click="togglePanel" title="Toggle property panel">
            <Icon :icon="faTableColumns" />
          </button>
          <button class="bar-btn" @click="toggleCollapse" :title="timelineCollapsed ? 'Show timeline' : 'Collapse timeline'">
            <Icon :icon="timelineCollapsed ? faChevronUp : faChevronDown" />
          </button>
        </div>
      </div>

      <!-- ===== TIMELINE TRACKS (folded away when collapsed) ===== -->
      <section v-if="!timelineCollapsed" class="timeline-panel">
        <div
          ref="tracksEl"
          class="tracks"
          @pointermove="onBlockPointerMove"
          @pointerup="onBlockPointerUp"
          @pointercancel="onBlockPointerUp"
        >
          <!-- Draggable playhead (ruling 1): a wide invisible hit strip around
               the 1px line, split by hourglass-half ornaments (ruling 2) — solid
               red while playing, idle-neutral when paused. -->
          <div
            class="playhead"
            :class="{ playing }"
            :style="{ left: playheadPct + '%' }"
            title="Drag to scrub"
            @pointerdown="onPlayheadDown"
            @pointermove="onPlayheadMove"
            @pointerup="onPlayheadUp"
            @pointercancel="onPlayheadUp"
          >
            <span class="orn top" />
            <span class="line" />
            <span class="orn bottom" />
          </div>
          <div
            v-for="(row, ri) in tracks"
            :key="ri"
            class="lane"
            :class="{ 'drop-ok': drag && drag.targetRow === ri && !drag.colliding, 'drop-bad': drag && drag.targetRow === ri && drag.colliding }"
            :ref="(el) => registerLane(el as Element | null, ri)"
            @pointerdown="(e) => seekFromClientX(e.clientX, e.currentTarget as HTMLElement)"
          >
            <span class="lane-tag">{{ ri === 0 ? "master" : ri }}</span>
            <div
              v-for="channel in row"
              :key="channel"
              class="block"
              :class="{
                focused: focused === channel,
                highlight: blockHighlighted(channel),
                disabled: disabled.has(channel),
                master: isMasterChannel(channel),
                dragging: drag && drag.channel === channel,
              }"
              :style="blockStyle(channel)"
              tabindex="0"
              :title="`${channel}${disabled.has(channel) ? ' (disabled)' : ''} · drag to reorder · right-click for stats · V toggles when focused`"
              @pointerdown.stop="(e) => onBlockPointerDown(e, channel)"
              @pointerenter="setHover([channel])"
              @pointerleave="clearHover"
              @focus="focusBlock(channel)"
              @click.stop="focusBlock(channel)"
              @contextmenu="onBlockContextMenu($event, channel)"
            >
              <span class="block-name">{{ channel }}</span>
            </div>
          </div>
          <!-- New-row drop zone (drag to the bottom to create a track). -->
          <div
            class="lane new-row"
            :class="{ 'drop-ok': drag && drag.targetRow >= tracks.length && !drag.colliding }"
            :ref="(el) => registerLane(el as Element | null, tracks.length)"
          >
            <span class="lane-tag">＋ new track</span>
          </div>
        </div>
      </section>
    </template>

    <!-- ===== right-click stream stats popover ===== -->
    <StatsPopover
      v-if="statsPopover"
      :x="statsPopover.x"
      :y="statsPopover.y"
      :entries="statsEntries"
      :playhead-ns="positionNs"
      :enabled="statsEnabled"
      :three-d-mode="statsThreeDLabel"
    />

    <!-- ===== confirm dialog (ruling 10: corrupt / mismatch) ===== -->
    <div v-if="confirmReset" class="modal-scrim">
      <div class="modal">
        <template v-if="confirmReset.reason === 'corrupt'">
          <h3>View layout unreadable</h3>
          <p>The saved view state (<code>{{ basename }}.ui.json</code>) is corrupt. Reset it to a fresh auto-packed layout?</p>
          <div class="modal-actions">
            <button class="danger" @click="resetUiState">Reset</button>
            <button @click="dismissConfirm">Not now</button>
          </div>
        </template>
        <template v-else>
          <h3>Streams changed</h3>
          <p>This recording's streams differ from your saved layout. Reset to a fresh auto-packed layout, or keep and merge your layout?</p>
          <div class="modal-actions">
            <button class="danger" @click="resetUiState">Reset</button>
            <button @click="keepLayout">Keep mine</button>
          </div>
        </template>
      </div>
    </div>
  </div>

  <TitleBar title="Viewer" :subtitle="compactPath" @height="(h) => (titleBarHeight = h)">
    <ExportTray
      :overview="exportOverview"
      :session-active="bannerState.active"
      @abort="abortExport"
      @clear="send({ type: 'export-clear-finished' })"
    />
    <button v-if="file" class="icon-button" title="Reset UI state (re-run auto layout)" @click="resetUiState">
      <Icon :icon="faArrowsRotate" />
    </button>
    <button v-if="file" class="icon-button" title="Reveal in Finder/Explorer" @click="openFolder">
      <Icon :icon="faFolderOpen" />
    </button>
  </TitleBar>

  <!-- Per-stream export dialog (spec 1–8). -->
  <ExportDialog
    v-if="exportDialogChannel && exportDialogStat"
    :channel="exportDialogChannel"
    :recording="basename"
    :width="exportDialogStat.width"
    :height="exportDialogStat.height"
    :default-fps="exportDialogStat.fps"
    :ffmpeg-available="!!file?.ffmpegAvailable"
    :undistort-available="exportUndistortAvailable"
    :undistort-reason="exportUndistortReason"
    :parallel="exportParallel"
    @submit="submitExport"
    @set-parallel="setExportParallel"
    @close="exportDialogChannel = null"
  />

  <!-- Abort-on-close confirm (spec 11). -->
  <div v-if="confirmClose" class="modal-scrim">
    <div class="modal">
      <h3>Exports in progress</h3>
      <p>This window has running video exports. Closing will abort them and delete the partial files. Close anyway?</p>
      <div class="modal-actions">
        <button class="danger" @click="confirmAbortAndClose">Abort &amp; close</button>
        <button @click="cancelClose">Keep open</button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.main {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-chrome);
  * {
    user-select: none;
  }
}

.notice {
  color: var(--text-faint);
  font-size: 1.05em;
  text-align: center;
  padding: 2em;
  flex-grow: 1;
}

// Live-capture banner (addendum): a flex child at the top of `.main`, so it
// pushes the preview area down (layout-stable, no overlay). Instant appearance.
.session-banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 0.4rem 0.9rem;
  background: var(--danger-bg);
  border-bottom: 1px solid var(--danger-strong);
  color: var(--warn);
  font-size: var(--fs-sm);
  .msg { flex: 1; }
  .dismiss {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 0.4ch;
    &:hover { color: var(--text); }
  }
}

.panel-export {
  margin-left: auto;
  align-self: center;
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  color: var(--text-dim);
  border-radius: 0.3ch;
  padding: 0.15rem 0.6ch;
  cursor: pointer;
  font-size: var(--fs-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
  &:hover { color: var(--text-bright); border-color: var(--accent); }
}

// ---- preview area (tile strip + optional property panel) ----
.preview-area {
  display: flex;
  flex-direction: row;
  min-height: 0;
  border-bottom: 1px solid var(--tint-2);
}

// ---- preview panel ----
.preview {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  background: var(--bg-chrome);

  .preview-head {
    display: flex;
    align-items: center;
    gap: 1.2ch;
    padding: 0.35em 1em;
    border-bottom: 1px solid var(--tint-1);
    background: var(--bg-panel-alt);
    font-size: 0.82em;
    color: var(--text-muted);
    .count {
      color: var(--text-dim);
    }
    .hint {
      color: var(--warn);
      border: 1px solid #fa06;
      border-radius: 3px;
      padding: 0 0.5em;
    }
    .head-controls {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 1.4ch;
    }
    .tilew {
      display: flex;
      align-items: center;
      gap: 0.6ch;
      color: var(--text-faint);
    }
    .tilew input {
      width: 12ch;
    }
  }

  .tiles {
    flex-grow: 1;
    display: flex;
    flex-direction: row;
    gap: 0.5em;
    padding: 0.5em;
    overflow-x: auto;
    overflow-y: hidden;
    min-height: 0;
  }

  .tile {
    // Fixed width (ruling 7) — reserves space; content changes never reflow
    // neighbors (layout stability).
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-canvas);
    border: 1px solid var(--tint-2);
    border-radius: 4px;
    overflow: hidden;
    outline: none;
    // Cross-highlight (ruling 5): box-shadow ring — visible, never reflows.
    // SNAP: instant on/off, no transition on this feedback path.
    &.highlight {
      box-shadow: 0 0 0 2px var(--accent-bright);
    }
    // Focused tile gets the stronger accent outline (matches focused blocks).
    &.focused {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }

    .tile-head {
      padding: 0.2em 0.6em;
      font-size: 0.78em;
      color: var(--text-dim);
      background: var(--bg-panel-alt);
      border-bottom: 1px solid var(--tint-1);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      .tile-name.master {
        color: var(--accent-bright);
        font-weight: 600;
      }
    }
    .tile-body {
      flex-grow: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
      background: var(--bg-chrome);
    }
    .tile-placeholder {
      color: var(--text-disabled);
      font-size: 0.85em;
    }
  }
}

// ---- property panel (focused-stream inspector, ruling 4) ----
.property-panel {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 0.6em 0.9em 0.9em;
  background: var(--bg-panel-alt);
  border-left: 1px solid var(--tint-2);
  color: var(--text-dim);
  font-size: 0.82em;

  // Left-edge resize handle (wider than its 1px seam so it's easy to grab).
  .panel-resize {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 8px;
    cursor: col-resize;
    z-index: 2;
    &:hover {
      background: #0af6;
    }
  }

  .panel-empty {
    margin: auto;
    padding: 2em 1em;
    text-align: center;
    color: var(--text-disabled);
  }

  .panel-head {
    display: flex;
    align-items: baseline;
    gap: 0.8ch;
    padding-bottom: 0.4em;
    margin-bottom: 0.5em;
    border-bottom: 1px solid var(--tint-1);
    .panel-name {
      color: var(--text-bright);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .panel-state {
      margin-left: auto;
      font-family: var(--font-mono);
      color: var(--ok);
      &.off {
        color: var(--text-disabled);
      }
    }
  }

  .panel-rows {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 1.2ch;
    row-gap: 0.16em;

    .group {
      grid-column: 1 / -1;
      margin-top: 0.7em;
      padding-top: 0.3em;
      border-top: 1px solid var(--tint-1);
      color: var(--text-faint);
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .row {
      display: contents;
      dt {
        color: var(--text-faint);
      }
      dd {
        margin: 0;
        text-align: right;
        font-family: var(--font-mono);
        color: var(--text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      &.live dd {
        color: var(--text-bright);
      }
      .sub {
        color: var(--text-disabled);
      }
    }
  }
}

// ---- transport bar (the draggable divider, ruling 3) ----
.transport-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 0.4em 1em;
  background: var(--bg-app);
  border-top: 1px solid var(--tint-2);
  border-bottom: 1px solid var(--tint-1);
  cursor: row-resize;
  // SNAP: no transition on the control path.
  &:hover,
  &.dragging {
    background: var(--bg-elevated);
  }

  .bar-group {
    display: flex;
    align-items: center;
    gap: 1ch;
    cursor: default; // the islands aren't drag handles
    &.left {
      flex: 1 1 0;
      justify-content: flex-start;
    }
    &.center {
      flex: 0 0 auto;
      justify-content: center;
    }
    &.right {
      flex: 1 1 0;
      justify-content: flex-end;
    }
  }

  .timecode {
    font-family: var(--font-mono);
    color: var(--text-bright);
    // Fixed field so ticking digits never shift the layout (layout stability).
    min-width: 26ch;
    text-align: center;
    // Playhead reads bright; the total duration is dimmed context.
    .sep {
      color: var(--text-faint);
    }
    .total {
      color: var(--text-faint);
    }
  }

  .play {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-app);
    color: var(--text-strong);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.3em 0;
    width: 2.6em;
    cursor: pointer;
    &:hover {
      background: var(--bg-elevated);
    }
  }
  select {
    background: var(--bg-chrome);
    color: var(--text-dim);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
  }
  .threed-global {
    display: flex;
    align-items: center;
    gap: 0.6ch;
    color: var(--text-faint);
    font-size: 0.85em;
  }
  .bar-btn {
    background: var(--bg-app);
    color: var(--text-strong);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.3em 0.55em;
    cursor: pointer;
    &:hover {
      background: var(--bg-elevated);
    }
    // Active (panel open) — accent outline; instant, no transition.
    &.active {
      color: var(--accent-bright);
      border-color: var(--accent);
    }
  }
}

// ---- timeline panel ----
.timeline-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex-grow: 1;
  background: var(--bg-chrome);

  .tracks {
    position: relative;
    flex-grow: 1;
    overflow-y: auto;
    padding: 0.4em 0;
    min-height: 0;

    // Draggable playhead (ruling 1/2): a WIDE invisible hit strip (14px) around
    // a 1px line, with hourglass-half ornaments at top + bottom. The strip is
    // centered on the playhead position (translateX -50%). Idle-neutral by
    // default; SOLID RED while playing — snap color change, no transition.
    .playhead {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 14px;
      transform: translateX(-50%);
      display: flex;
      justify-content: center;
      cursor: ew-resize;
      pointer-events: auto;
      z-index: 5;
      // idle color (paused)
      --ph-color: var(--text-faint);
      &.playing {
        --ph-color: var(--danger);
      }

      .line {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 2px;
        background: var(--ph-color);
      }
      // Top ornament: downward-pointing half (▽) at the top of the line.
      // Bottom ornament: upward-pointing half (△) — together an hourglass split
      // by the timeline. Pure CSS triangles so they take --ph-color.
      .orn {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 0;
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        &.top {
          top: 0;
          border-top: 8px solid var(--ph-color);
        }
        &.bottom {
          bottom: 0;
          border-bottom: 8px solid var(--ph-color);
        }
      }
    }

    .lane {
      position: relative;
      height: 2.6em;
      margin: 0.25em 0.6em;
      border: 1px dashed var(--tint-1);
      border-radius: 4px;
      background: #ffffff06;
      // SNAP: instant drop-target feedback, no eased transition.
      &.drop-ok {
        border-color: var(--accent-bright);
        background: #0af2;
      }
      &.drop-bad {
        border-color: #f55;
        background: #f552;
      }
      &.new-row {
        height: 1.8em;
        opacity: 0.6;
      }
      .lane-tag {
        position: absolute;
        left: 0.5ch;
        top: 0.2em;
        font-size: 0.68em;
        color: var(--text-disabled);
        pointer-events: none;
        z-index: 1;
      }
    }

    .block {
      position: absolute;
      top: 0.25em;
      bottom: 0.25em;
      display: flex;
      align-items: center;
      gap: 0.6ch;
      padding: 0 0.6ch;
      background: #2a3a4a;
      border: 1px solid #4a6a8a;
      border-radius: 3px;
      color: #dfe8f0;
      font-size: 0.8em;
      overflow: hidden;
      cursor: grab;
      touch-action: none;
      // Instant hover/focus cues (no transition on the control path).
      &:hover {
        border-color: #6aa;
      }
      &.master {
        background: #23405a;
        border-color: var(--accent-bright);
      }
      &.focused {
        outline: 2px solid var(--accent);
        outline-offset: 0;
      }
      // Cross-highlight (ruling 5): box-shadow ring — instant, no reflow.
      &.highlight {
        box-shadow: 0 0 0 2px var(--accent-bright);
      }
      &.disabled {
        opacity: 0.4;
        background: var(--border);
        border-color: var(--border-muted);
      }
      &.dragging {
        cursor: grabbing;
        opacity: 0.85;
        z-index: 6;
      }
      .block-name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
  }
}

// ---- modal ----
.modal-scrim {
  position: fixed;
  inset: 0;
  background: #000a;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  .modal {
    background: var(--bg-panel-alt);
    border: 1px solid var(--tint-3);
    border-radius: 8px;
    padding: 1.2em 1.4em;
    max-width: 34ch;
    color: var(--text-strong);
    h3 {
      margin: 0 0 0.6em;
      color: var(--text);
    }
    p {
      margin: 0 0 1em;
      font-size: 0.9em;
      color: var(--text-dim);
      line-height: 1.4;
    }
    code {
      color: #9cf;
      font-size: 0.85em;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 1ch;
      button {
        background: var(--bg-app);
        color: var(--text-strong);
        border: 1px solid var(--border-strong);
        border-radius: 4px;
        padding: 0.35em 1.1em;
        cursor: pointer;
        &:hover {
          background: var(--bg-elevated);
        }
        &.danger {
          border-color: var(--danger-strong);
          color: var(--danger-text);
          &:hover {
            background: var(--danger-bg);
          }
        }
      }
    }
  }
}

// ---- title-bar buttons (icon-only, per the app-wide ruling) ----
// Mirrors AppWindow.vue's `.icon-button` so viewer chrome matches the app.
.icon-button {
  background: none;
  border: none;
  padding: 0.4em;
  margin: 0 0 0 0.2ch;
  cursor: pointer;
  color: inherit;
  border-radius: 4px;
  outline: 1px solid transparent;
  // SNAP: no transition on the control path.
  &:not(:disabled):hover {
    background: var(--tint-1);
    outline: 1px solid var(--border-muted);
  }
}
</style>
