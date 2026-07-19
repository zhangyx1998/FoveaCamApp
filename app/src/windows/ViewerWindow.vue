<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  STANDALONE recorder viewer window — the wiring + DOM for the multi-track
  correlation UI: an upper preview panel of playhead-spanning tiles over a lower
  read-only timeline of tracks/blocks. Pure model + algorithms live in
  src/viewer/timeline.ts + sidecar.ts; playback runs in the engine.
  spec: docs/spec/viewer.md#timeline (engine topology: #topology)
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
  composeTileSlots,
  decodeSet,
  detectMaster,
  detectPairs,
  dropCollides,
  firstMeaningfulNs,
  initialLayout,
  insertBlockAt,
  layoutMismatch,
  moveBlock,
  reconcileLayout,
  reconcileTileOrder,
  sideOf,
  trackColor,
  THREE_D_MODES,
  type ChannelBlock,
  type ThreeDMode,
  type Tile,
  type TileSlot,
} from "../viewer/timeline";
import {
  fracOf,
  fullViewport,
  interpolatePlayhead,
  nsAtX,
  panSoft,
  rulerTicks,
  settleTarget,
  zoomAt,
  type RulerTick,
  type TimeViewport,
} from "../viewer/time-viewport";
import {
  assignColors,
  footprintSide,
  groupByStream,
  groupStreams,
  projectQuad,
  quadPoints,
  vergencePlaneDepth,
  formatDepth,
  type FootprintGroup,
} from "../viewer/footprints";
import {
  COLLAPSED_SPLIT,
  DEFAULT_PANEL_WIDTH,
  DEFAULT_SPLIT,
  MAX_PANEL_WIDTH,
  MAX_SPLIT,
  MIN_PANEL_WIDTH,
  MIN_SPLIT,
  type SidecarLoad,
  type SidecarState,
} from "../viewer/sidecar";
import {
  equalFractions,
  reconcileFractions,
  resizeAtDivider,
} from "../viewer/tile-split";
import { createViewerFramePublisher } from "../viewer/viewer-frame-bridge";
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
// The playback engine is a MAIN-owned utilityProcess (a renderer can't host a
// Node worker). Main brokers a MessagePort back over `viewer:port`; we talk to
// the engine directly over it.

const file = ref<ViewerFileInfo | null>(null);
const openError = ref<string | null>(null);
const playing = ref(false);
const workerPositionNs = ref(0);
const descriptors = ref<Record<string, PlaybackDoc>>({});
/** Latest-per-stream telemetry docs (`{stream, seq, t, volt, angle, affine}`) —
 *  the fovea-footprint overlay's source. Keyed by the doc's `stream` field
 *  (== the recorded frame channel name). Reset on seek like descriptors. */
const telemetry = ref<Record<string, PlaybackDoc>>({});
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
      // Re-anchor the smooth playhead to this authoritative sample.
      lastPosWall = performance.now();
      if (!ev.playing) displayNs.value = ev.positionNs; // paused sample snaps
      break;
    case "telemetry": {
      // Per-frame extras → the footprint overlay. Retain the LATEST doc per
      // stream (latest-wins at playback rate, like descriptors).
      const st = (ev.doc as { stream?: unknown }).stream;
      if (typeof st === "string" && st)
        telemetry.value = { ...telemetry.value, [st]: ev.doc };
      break;
    }
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

// --- live-capture banner ----------------------------------------
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
    // stream would silently mis-undistort it.
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
  // full timestamp scan at dialog-open is avoided.
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
  framePub?.dispose();
  framePub = null;
  if (playheadRaf !== null) cancelAnimationFrame(playheadRaf);
  if (settleTimer) clearTimeout(settleTimer);
  tracksRO?.disconnect();
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
// Preview tile order: a persisted permutation of TRACK indices giving
// the left→right slot order. Reconciled against the live track count on use.
const tileOrder = ref<number[]>([]);
// GLOBAL 3D view mode: one mode for EVERY
// L/R pair, chosen in the preview header — no longer per pair.
const threeD = ref<ThreeDMode>("disabled");
const split = ref<number>(DEFAULT_SPLIT); // preview height fraction
// Preview tile widths: persisted FRACTIONS (sum 1) — the tiles row
// always fills 100% and never scrolls. Reconciled to the live slot count on use
// (`effectiveTileSizes`); an empty list defaults to equal fractions. Divider
// drags between adjacent tiles rewrite this pair-wise.
const tileSizes = ref<number[]>([]);
// Property panel — persisted visibility + width.
const panelOpen = ref(false);
const panelWidth = ref<number>(DEFAULT_PANEL_WIDTH);
const initialized = ref(false);
/** Non-null while a confirm dialog is up (corrupt/mismatch). */
const confirmReset = ref<null | { reason: "corrupt" | "mismatch" }>(null);

/** pair-membership lookup: channel → {pair, mode}. Every pair takes the SINGLE
 *  global mode; the tile/decode-set derivation is unchanged
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
    playheadNs: workerPositionNs.value,
    panelOpen: panelOpen.value,
    panelWidth: panelWidth.value,
    tileOrder: tileOrder.value,
    tileSizes: tileSizes.value,
  };
}

/** Persist the current UI state (debounced write-through, worker-side). */
function persist(): void {
  if (!initialized.value || !file.value) return;
  send({ type: "save-ui", state: currentSidecarState() });
}

/** Seed a fresh layout + defaults (greedy fit runs ONLY here). */
function initializeLayout(persistIt: boolean): void {
  tracks.value = initialLayout(blocks.value, master.value.channel);
  disabled.value = new Set();
  tileOrder.value = []; // natural track order until the user drags tiles
  tileSizes.value = []; // equal fractions until the user drags a divider
  threeD.value = "disabled";
  split.value = DEFAULT_SPLIT;
  panelOpen.value = false;
  panelWidth.value = DEFAULT_PANEL_WIDTH;
  initialized.value = true;
  seekInitial(0); // land on the first meaningful frame
  if (persistIt) persist();
}

/** Seek to the initial playhead: a persisted position wins; otherwise
 *  the earliest block start (`firstMeaningfulNs`) so at least one tile shows on
 *  open, instead of a blank t=0. A 0 target (no blocks) is a harmless no-op. */
function seekInitial(persistedNs: number): void {
  const target = persistedNs > 0 ? persistedNs : firstMeaningfulNs(blocks.value);
  if (target > 0) send({ type: "seek", tNs: target });
}

function applySidecar(load: SidecarLoad): void {
  if (load.status === "absent") {
    // Nothing to lose — silently initialize + persist.
    initializeLayout(true);
    return;
  }
  if (load.status === "corrupt") {
    // Present but unreadable: use in-memory defaults WITHOUT overwriting; ask.
    initializeLayout(false);
    confirmReset.value = { reason: "corrupt" };
    return;
  }
  // status === "ok": restore. threeD/disabled/split/tileSizes apply regardless.
  const st = load.state;
  disabled.value = new Set(st.disabled);
  tileOrder.value = st.tileOrder ? [...st.tileOrder] : [];
  tileSizes.value = st.tileSizes ? [...st.tileSizes] : [];
  threeD.value = st.threeD; // global mode (sidecar already collapsed old maps)
  split.value = st.split;
  panelOpen.value = st.panelOpen;
  panelWidth.value = st.panelWidth;
  if (layoutMismatch(st.tracks, frameChannels.value)) {
    // Channels changed since last view: reconcile in-memory (don't discard),
    // and ask before overwriting.
    tracks.value = reconcileLayout(st.tracks, frameChannels.value);
    confirmReset.value = { reason: "mismatch" };
  } else {
    tracks.value = st.tracks.map((r) => [...r]);
  }
  initialized.value = true;
  // persisted playhead wins; otherwise the first meaningful frame.
  seekInitial(st.playheadNs);
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

// --- worker decode gate (enabled-set) -----------------------------

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

// --- time viewport ----------------------------------------------
// The visible time window over the tracks. NOT persisted — it resets
// to the full recording whenever a file's duration becomes known. Every pointer
// x ⟷ time mapping (blocks, playhead, ruler, click-seek, wheel) goes through
// `fracOf`/`nsAtX` against this so pan/zoom is uniform.
const viewport = ref<TimeViewport>(fullViewport(0));
watch(durationNs, (d) => (viewport.value = fullViewport(d)), { immediate: true });
/** Pointer clientX → viewport fraction [0,1] over the tracks rect. */
function fracAtClientX(clientX: number, r: DOMRect): number {
  return r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0.5;
}

// --- smooth playhead --------------------------------------------
// While PLAYING, a rAF loop extrapolates the last worker position by wall-clock
// · rate so the visual playhead line glides between the (coarser) worker
// `position` events; each event RE-ANCHORS it, and pause/seek SNAP. Only the
// playhead line + its % use this — tiles/overlays keep the raw worker position.
const displayNs = ref(0);
let lastPosWall = 0; // performance.now() at the last worker position event
let playheadRaf: number | null = null;
function playheadLoop(): void {
  if (!playing.value) {
    playheadRaf = null;
    return;
  }
  displayNs.value = interpolatePlayhead(
    workerPositionNs.value, lastPosWall, performance.now(),
    rate.value, playing.value, durationNs.value,
  );
  playheadRaf = requestAnimationFrame(playheadLoop);
}
watch(playing, (p) => {
  if (p) {
    // Anchor NOW so the first rAF frame doesn't extrapolate from a stale sample
    // (the paused-state timestamp) and jump to the end before the next event.
    lastPosWall = performance.now();
    displayNs.value = workerPositionNs.value;
    if (playheadRaf === null) playheadRaf = requestAnimationFrame(playheadLoop);
  } else {
    if (playheadRaf !== null) cancelAnimationFrame(playheadRaf);
    playheadRaf = null;
    displayNs.value = workerPositionNs.value; // pause snaps to the true position
  }
});
/** The playhead's VISUAL position: interpolated while playing, the scrub target
 *  while scrubbing (seek snaps), else the raw worker position. */
const smoothPositionNs = computed(() => {
  if (scrubbing.value) return scrubNs.value;
  if (playing.value) return displayNs.value;
  return workerPositionNs.value;
});

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
  telemetry.value = {}; // reset-on-seek: no future footprint left on screen
  send({ type: "seek", tNs: clamped });
}
/** Click-to-seek on a timeline track lane (snap). Maps pointer x → time through
 *  the VIEWPORT (`nsAtX`) so it matches the ruler + draggable playhead;
 *  `seekTo` clamps to [0, duration]. */
function seekFromClientX(clientX: number, el: HTMLElement): void {
  const r = tracksEl.value?.getBoundingClientRect() ?? el.getBoundingClientRect();
  seekTo(nsAtX(clientX, r.left, r.width, viewport.value));
  scrubbing.value = false;
}

// --- draggable playhead -------------------------------
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
  seekTo(nsAtX(e.clientX, r.left, r.width, viewport.value));
}
function onPlayheadMove(e: PointerEvent): void {
  if (!playheadDrag.value || !tracksEl.value) return;
  const r = tracksEl.value.getBoundingClientRect();
  seekTo(nsAtX(e.clientX, r.left, r.width, viewport.value));
}
function onPlayheadUp(): void {
  if (!playheadDrag.value) return;
  playheadDrag.value = false;
  scrubbing.value = false;
  persist();
}

// --- preview tiles ----------------------------------------------------------

// ONE tile slot per track — a real tile or a placeholder (no-frame /
// disabled / pair-collapsed). Derived on the RAW worker position (not the smooth
// playhead) so tiles don't re-derive every animation frame during playback.
const tileSlotsRaw = computed<TileSlot[]>(() =>
  composeTileSlots(tracks.value, blocks.value, positionNs.value, enabledSet.value, pairModeOf.value),
);
/** The persisted order reconciled to the current track count (drop stale, append
 *  missing). Identity when they already agree. */
const effectiveOrder = computed(() => reconcileTileOrder(tileOrder.value, tracks.value.length));
/** Slots in the persisted left→right order (slot i ↔ track i, remapped). */
const orderedSlots = computed<TileSlot[]>(() => {
  const byTrack = new Map(tileSlotsRaw.value.map((s) => [s.track, s]));
  return effectiveOrder.value
    .map((ti) => byTrack.get(ti))
    .filter((s): s is TileSlot => s !== undefined);
});
/** How many slots actually render a view (placeholders excluded) — the header
 *  count keeps its "N views" meaning. */
const tileViewCount = computed(() => orderedSlots.value.filter((s) => s.kind === "tile").length);
/** Persisted tile FRACTIONS reconciled to the live slot count: drops
 *  stale entries, appends missing, renormalizes to sum 1; equal fractions when
 *  none persisted. The width source of truth for the flex row. */
const effectiveTileSizes = computed(() =>
  reconcileFractions(tileSizes.value, orderedSlots.value.length),
);
/** Per-slot `flex` shorthand: `<grow> 1 0` so grow == fraction. Dividers are
 *  fixed-px flex items; the tiles share the REMAINING width proportionally, so
 *  the row always fills 100% exactly regardless of divider/padding pixels. */
function tileFlex(si: number): string {
  return `${effectiveTileSizes.value[si] ?? equalFractions(orderedSlots.value.length)[si] ?? 1} 1 0`;
}
/** Stable per-slot key: real tiles key on their content, placeholders on track. */
function slotKey(slot: TileSlot): string {
  return slot.kind === "tile" ? `t:${tileKey(slot.tile)}` : `p:${slot.track}:${slot.reason}`;
}
/** The track hue for a slot's header chip — same hue as its lane. */
function slotColor(slot: TileSlot): string {
  const row = tracks.value[slot.track];
  return row ? trackColor(row, slot.track) : "transparent";
}
/** The lane tag for a track index (0 = master), shared by tiles + lanes. */
function trackTag(track: number): string {
  return track === 0 ? "master" : String(track);
}
/** Placeholder-slot accessors (kept as helpers so the template never leans on
 *  v-else discriminated-union narrowing). */
function placeholderLabel(slot: TileSlot): string {
  return slot.kind === "placeholder" ? slot.label : "";
}
function placeholderReason(slot: TileSlot): string {
  if (slot.kind !== "placeholder") return "";
  switch (slot.reason) {
    case "no-frame":
      return "no frame at playhead";
    case "disabled":
      return "disabled";
    case "pair-collapsed":
      return "merged with its pair";
    default:
      return "";
  }
}

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
 *  3-channel RGB Mat (no core dependency). Uses the min of the two
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
/** Stable per-tile broadcast/descriptor key. == `tileKey`: single →
 *  channel name, pair → `pair:<base>`. MUST equal the projection descriptor's
 *  `tileKey` and the frame-bridge broadcast key so a projection subscribes to
 *  the exact tile it mirrors. */
const tileKeyOf = tileKey;
function tileLabel(tile: Tile): string {
  if (tile.kind === "single") return tile.channel;
  const m = tile.mode === "anaglyph" ? "3D" : tile.mode === "left-only" ? "L" : "R";
  return `${tile.pair.base} (${m})`;
}

// --- projectable tiles -------------------------------------------
// A tile can be projected to a standalone projection window; the projection
// MIRRORS the tile by subscribing to a same-origin frame broadcast keyed by
// (recording, tileKey). We publish a tile's CURRENT displayed Mat only while a
// projection has actively subscribed to its key (`wanted`) — ref-counted, so
// the hot path is untouched with no projection open. Frames ride the existing
// `frameTick` cadence (no new timer).
let framePub: ReturnType<typeof createViewerFramePublisher> | null = null;
/** Post every displayed real tile whose key a projection wants, at the current
 *  playhead. Called on each new decoded frame AND when demand changes (so a
 *  projection opened while paused mirrors the current frame immediately). */
function publishWantedTiles(): void {
  if (!framePub) return;
  for (const slot of orderedSlots.value) {
    if (slot.kind !== "tile") continue;
    const key = tileKeyOf(slot.tile);
    if (!framePub.wanted(key)) continue;
    const mat = tileMat(slot.tile);
    if (mat) framePub.post(key, { data: mat, shape: mat.shape });
  }
}
// Stand up the publisher once a file is open (recording id = `basename`). The
// viewer window binds one path for its lifetime, so this creates once; the
// file-change guard is defensive (dispose + rebuild on a new recording id).
watch(
  [file, basename],
  () => {
    if (file.value && !framePub)
      framePub = createViewerFramePublisher(basename.value, publishWantedTiles);
  },
  { flush: "post" },
);
// New decoded frame → mirror it to any subscribed projection (skips instantly
// when nothing is subscribed via `wanted`).
watch(frameTick, publishWantedTiles);

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

// --- fovea footprint overlay (fovea-footprint-overlay) ----------------------
// Projected boxes of each recorded fovea stream's frame corners (through its
// per-frame `affine`) onto the WIDE/master tile, color-coded by fovea PAIR and
// hover-linked to the timeline. Toggle DEFAULT OFF: only the hovered/focused
// stream(s) draw; ON draws every stream active at the playhead.
const showAllProjections = ref(false);

/** True when the container carries a non-master, side-tagged frame stream that
 *  could project a footprint — gates the toggle's visibility. */
const footprintCapable = computed(() =>
  frameChannels.value.some(
    (c) => c !== master.value.channel && footprintSide(c) !== null,
  ),
);

/** Color GROUPS over the container's frame channels: L/R of a pair share one. */
const footprintGroups = computed<FootprintGroup[]>(() => groupStreams(frameChannels.value));
const groupOfStream = computed(() => groupByStream(footprintGroups.value));
/** group key → RAW color index (greedy interval-coloring over block ranges).
 *  Disjoint groups reuse an index; overlapping ones get distinct indices. */
const footprintColorIndex = computed(() =>
  assignColors(
    footprintGroups.value.map((g) => {
      let startNs = Infinity;
      let lastNs = -Infinity;
      for (const s of g.streams) {
        const b = blockByChannel.value.get(s);
        if (!b) continue;
        startNs = Math.min(startNs, b.startNs);
        lastNs = Math.max(lastNs, b.lastNs);
      }
      return Number.isFinite(startNs)
        ? { key: g.key, startNs, lastNs }
        : { key: g.key, startNs: 0, lastNs: 0 };
    }),
  ),
);

// Footprints share TARGET_COLORS with the descriptor bboxes on the SAME center
// tile — offset the footprint sub-range so a tracked-target rect and a fovea
// footprint don't independently land on one color meaning two different things
// (descriptor indices start at 0 and are few).
const FOOTPRINT_PALETTE_OFFSET = 4;
function footprintColor(stream: string): string {
  const g = groupOfStream.value.get(stream);
  const idx = g ? footprintColorIndex.value.get(g.key) ?? 0 : 0;
  return TARGET_COLORS[(FOOTPRINT_PALETTE_OFFSET + idx) % TARGET_COLORS.length]!;
}

/** The pair's vergence-plane depth (mm) from the two eyes' recorded angles +
 *  the container baseline — null unless BOTH eyes have telemetry + a baseline. */
function pairDepth(g: FootprintGroup | undefined): number | null {
  if (!g || !g.left || !g.right) return null;
  const aL = (telemetry.value[g.left] as { angle?: { x?: number } } | undefined)?.angle;
  const aR = (telemetry.value[g.right] as { angle?: { x?: number } } | undefined)?.angle;
  return vergencePlaneDepth(aL?.x, aR?.x, file.value?.baselineMm ?? null);
}

/** True iff `s`'s block spans the current playhead — the honesty gate: a
 *  retained telemetry doc from an ENDED block must never project onto a frame
 *  from a different time (the hover branch was
 *  missing this and drew a t=5s footprint over a t=10s frame). */
function activeAtPlayhead(s: string): boolean {
  const b = blockByChannel.value.get(s);
  return !!b && positionNs.value >= b.startNs && positionNs.value <= b.lastNs;
}

/** Streams whose footprint should draw right now: ON → every affine-bearing
 *  stream active at the playhead; OFF → only highlighted (hover/focus) ones —
 *  ALSO playhead-gated (hovering an ended block reveals nothing). The master
 *  (wide) stream carries no affine, so it never self-draws.
 *
 *  Partial-pair suppression: after a paused scrub only ONE stream
 *  of a pair may have recovered telemetry (single multiplexed channel); a lone
 *  box in the pair's shared color reads as a bug, so ALL mode draws a paired
 *  stream only when BOTH sides carry telemetry (full state returns on play).
 *  Explicit hover/focus still shows the recovered side alone — the user asked
 *  for that specific stream. */
function footprintStreams(): string[] {
  const withAffine = Object.keys(telemetry.value).filter(
    (s) =>
      Array.isArray((telemetry.value[s] as { affine?: unknown }).affine) &&
      activeAtPlayhead(s),
  );
  if (!showAllProjections.value)
    return withAffine.filter((s) => highlightChannels.value.has(s));
  return withAffine.filter((s) => {
    const g = groupOfStream.value.get(s);
    if (!g || !g.left || !g.right) return true; // unpaired: no partner to wait on
    return g.left in telemetry.value && g.right in telemetry.value;
  });
}

interface FootprintBox {
  stream: string;
  points: string;
  color: string;
  /** Corner to anchor the label at (first projected corner). */
  label: { x: number; y: number };
  depth: number | null;
  highlighted: boolean;
}

/** Footprint boxes to draw on `channel` — only the DESIGNATED wide/master tile
 *  (the affine maps into wide undistorted pixels, the tile's own space). */
function footprintBoxesFor(channel: string): FootprintBox[] {
  if (!master.value.designated || channel !== master.value.channel) return [];
  const out: FootprintBox[] = [];
  for (const stream of footprintStreams()) {
    const doc = telemetry.value[stream] as { affine?: number[] } | undefined;
    const info = channelInfoByName.value.get(stream);
    const w = Number(info?.metadata.width);
    const h = Number(info?.metadata.height);
    const quad = projectQuad(doc?.affine, w, h);
    if (!quad) continue;
    const g = groupOfStream.value.get(stream);
    out.push({
      stream,
      points: quadPoints(quad),
      color: footprintColor(stream),
      label: quad[0]!,
      depth: pairDepth(g),
      highlighted: highlightChannels.value.has(stream),
    });
  }
  return out;
}

/** The hover label for a footprint box: stream id, plus the pair depth once the
 *  box (or its stream) is highlighted. */
function footprintLabel(box: FootprintBox): string {
  if (!box.highlighted || box.depth === null) return box.stream;
  return `${box.stream} · ${formatDepth(box.depth)}`;
}

/** The overlay SVG is in the master frame's PIXEL user-space (viewBox = its
 *  dims), so label/stroke sizes are derived from the master image height to read
 *  consistently at any sensor resolution. */
const footprintFontSize = computed(() => {
  const info = channelInfoByName.value.get(master.value.channel ?? "");
  const h = Number(info?.metadata.height);
  return Number.isFinite(h) && h > 0 ? Math.max(10, Math.round(h / 38)) : 14;
});
const footprintStroke = computed(() => Math.max(1.5, footprintFontSize.value * 0.22));

// --- timeline geometry (viewport-aware) ---------------------------

/** A block's on-screen x/width, mapped through the viewport (`fracOf`). Blocks
 *  outside the window land off-screen (clipped by the lane's overflow). */
function blockStyle(channel: string): Record<string, string> {
  const b = blockByChannel.value.get(channel);
  if (!b || durationNs.value <= 0) return { display: "none" };
  const left = fracOf(b.startNs, viewport.value) * 100;
  const right = fracOf(b.lastNs, viewport.value) * 100;
  const width = Math.max(0.4, right - left);
  return { left: `${left}%`, width: `${width}%` };
}
/** Viewport fraction (0..1) of a file-relative ns, as a `%` string — the shared
 *  mapping for the playhead, ruler ticks, and bleed strips. */
function fracPct(ns: number): string {
  return `${fracOf(ns, viewport.value) * 100}%`;
}
const playheadPct = computed(() => fracOf(smoothPositionNs.value, viewport.value) * 100);

// Bleed strips: the dimmed hatched areas BEFORE t=0 and AFTER the end
// mark the recording boundaries; they pan/zoom with the content. Rendered only
// when the viewport actually shows past a bound.
const bleedBeforePct = computed(() => {
  const left = fracOf(0, viewport.value) * 100;
  return left > 0 ? Math.min(100, left) : 0;
});
const bleedAfterPct = computed(() => {
  const right = fracOf(durationNs.value, viewport.value) * 100;
  return right < 100 ? Math.max(0, right) : 100;
});

// --- ruler -------------------------------------------------------
// An absolute overlay strip at the top of `.tracks`: nice-number ticks from
// `rulerTicks`, re-rendered on any viewport OR width change. Clicking/dragging it
// seeks (clamped to [0, duration]) — the lanes' own click-to-seek stays.
const tracksWidth = ref(0);
const rulerT = computed<RulerTick[]>(() =>
  tracksWidth.value > 0 ? rulerTicks(viewport.value, tracksWidth.value) : [],
);
const rulerDrag = ref(false);
function rulerSeekAt(clientX: number): void {
  if (!tracksEl.value) return;
  const r = tracksEl.value.getBoundingClientRect();
  seekTo(nsAtX(clientX, r.left, r.width, viewport.value)); // seekTo clamps
}
function onRulerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  e.stopPropagation();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  rulerDrag.value = true;
  rulerSeekAt(e.clientX);
}
function onRulerMove(e: PointerEvent): void {
  if (!rulerDrag.value) return;
  rulerSeekAt(e.clientX);
}
function onRulerUp(): void {
  if (!rulerDrag.value) return;
  rulerDrag.value = false;
  scrubbing.value = false;
  persist();
}

// --- wheel: pan / zoom + spring-back settle ----------------------
const ZOOM_RATE = 0.0025; // per wheel deltaY unit (multiplicative span factor)
let settleTimer: ReturnType<typeof setTimeout> | null = null;
function onTracksWheel(e: WheelEvent): void {
  if (durationNs.value <= 0 || !tracksEl.value) return;
  const r = tracksEl.value.getBoundingClientRect();
  if (e.ctrlKey) {
    // ctrl+wheel (= macOS pinch): zoom centered on the cursor (nodegraph idiom).
    e.preventDefault();
    const anchorFrac = fracAtClientX(e.clientX, r);
    // `zoomAt` divides span by `factor`, so factor>1 zooms IN. deltaY<0
    // (scroll-up / pinch-out) → factor>1 → zoom in (nodegraph convention).
    const factor = Math.exp(-e.deltaY * ZOOM_RATE);
    viewport.value = zoomAt(viewport.value, factor, anchorFrac, durationNs.value);
    scheduleSettle();
  } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    // Predominantly horizontal → pan X (rubber-band past bounds via panSoft).
    // Vertical scroll falls THROUGH to natively scroll the track list.
    e.preventDefault();
    const span = viewport.value.t1 - viewport.value.t0;
    const deltaNs = (e.deltaX / (r.width || 1)) * span;
    viewport.value = panSoft(viewport.value, deltaNs, durationNs.value);
    scheduleSettle();
  }
}
/** After the wheel gesture goes idle (~150 ms), SNAP any out-of-bounds viewport
 *  back to its legal `settleTarget` (instantaneous bounce — the
 *  rubber-band RESISTANCE during the drag stays in `panSoft`; only the settle is
 *  instant). Idle-debounced (not synchronous per-wheel) so the snap fires once
 *  the gesture stops rather than fighting a continuing scroll. */
function scheduleSettle(): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    animateSettle();
  }, 150);
}
function animateSettle(): void {
  const target = settleTarget(viewport.value, durationNs.value);
  if (viewport.value.t0 === target.t0 && viewport.value.t1 === target.t1) return; // already legal
  viewport.value = target; // immediate snap — no rAF ease
}

// Track the `.tracks` width for the ruler (re-render ticks on resize). The
// element mounts/unmounts with the collapse toggle, so bind the observer to the
// ref rather than a one-shot onMounted.
let tracksRO: ResizeObserver | null = null;
watch(tracksEl, (el) => {
  tracksRO?.disconnect();
  tracksRO = null;
  if (el) {
    tracksWidth.value = el.clientWidth;
    tracksRO = new ResizeObserver(() => (tracksWidth.value = el.clientWidth));
    tracksRO.observe(el);
  }
});

const isMasterChannel = (channel: string) => channel === master.value.channel;
/** Track hue for a lane: a CSS custom property the lane + its blocks
 *  tint against (border/accent only — not a loud fill). */
function laneColor(row: readonly string[], index: number): string {
  return trackColor(row, index);
}

// --- preview tile reordering -------------------------------------
// Pointer-drag a tile's header to rearrange the slots. `overIndex` is an
// INSERTION index in [0, n]; a thin drop indicator renders there. On release the
// track index is moved within the persisted `tileOrder` and saved.
type TileDragState = { fromIndex: number; pointerId: number; overIndex: number; moved: boolean };
const tileDrag = ref<TileDragState | null>(null);
const tileEls = ref<HTMLElement[]>([]);
function registerTileEl(el: Element | null, i: number): void {
  if (el instanceof HTMLElement) tileEls.value[i] = el;
}
/** Insertion index (0..n) for a pointer x over the tile strip. */
function tileInsertAtX(clientX: number): number {
  const n = orderedSlots.value.length;
  for (let i = 0; i < n; i++) {
    const el = tileEls.value[i];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return n;
}
function onTileDragDown(e: PointerEvent, idx: number): void {
  if (e.button !== 0) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  tileDrag.value = { fromIndex: idx, pointerId: e.pointerId, overIndex: idx, moved: false };
}
function onTileDragMove(e: PointerEvent): void {
  const d = tileDrag.value;
  if (!d || e.pointerId !== d.pointerId) return;
  tileDrag.value = { ...d, overIndex: tileInsertAtX(e.clientX), moved: true };
}
function onTileDragUp(e: PointerEvent): void {
  const d = tileDrag.value;
  if (!d || e.pointerId !== d.pointerId) return;
  tileDrag.value = null;
  if (!d.moved) return; // a bare click (no move) leaves order + focus untouched
  reorderTiles(d.fromIndex, d.overIndex);
}
/** Move the slot at `from` (visual index) to an INSERTION point, rewriting the
 *  persisted track-index order. */
function reorderTiles(from: number, insertBefore: number): void {
  const order = [...effectiveOrder.value];
  if (from < 0 || from >= order.length) return;
  let target = insertBefore > from ? insertBefore - 1 : insertBefore; // account for removal
  target = Math.max(0, Math.min(order.length - 1, target));
  if (target === from) return;
  const [moved] = order.splice(from, 1);
  order.splice(target, 0, moved!);
  tileOrder.value = order;
  persist();
}

/** Set the single GLOBAL 3D mode — applies to every pair. */
function setThreeDMode(event: Event): void {
  threeD.value = (event.target as HTMLSelectElement).value as ThreeDMode;
  persist();
}

// --- v-toggle: focused block + `v` toggles the stream ------------
const focused = ref<string | null>(null);
function focusBlock(channel: string): void {
  focused.value = channel;
}
/** Focus a preview tile's stream (its primary channel) — a merged pair focuses
 *  its left eye, which is what the property panel + `v` act on. */
function focusTile(tile: Tile): void {
  focused.value = tile.channels[0] ?? null;
}

// --- cross-highlighting -------------------------------
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
  // jump), the universal player conventions. ---
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
    // press, not from a stale worker echo — otherwise rapid presses collapse to
    // ~1 frame). Debounced release settles back onto the worker position and
    // persists once per burst.
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

// --- block drag/drop (snap; collision refused; insert new row) -
// A drop target is EITHER a row (move onto that lane, `moveBlock`) OR a boundary
// BETWEEN lanes (insert `channel` as a new row there, `insertBlockAt`).
// The boundary is the thin top/bottom edge band of each lane.
const LANE_EDGE_PX = 6;
type DragState = {
  channel: string;
  pointerId: number;
  y: number; // current pointer clientY
  targetRow: number; // hovered row (or tracks.length for a new bottom row); -1 when inserting
  insertBefore: number | null; // boundary insertion index, else null
  colliding: boolean;
};
const drag = ref<DragState | null>(null);
const trackLaneEls = ref<HTMLElement[]>([]);
function registerLane(el: Element | null, row: number): void {
  if (el instanceof HTMLElement) trackLaneEls.value[row] = el;
}

/** Classify a pointer y over the lane stack: a lane row, or a between-lane
 *  insertion boundary. Below the last lane → a new bottom row. */
function dropTargetAtY(clientY: number): { row: number } | { insertBefore: number } {
  const lanes = trackLaneEls.value;
  for (let i = 0; i < tracks.value.length; i++) {
    const el = lanes[i];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom) {
      if (clientY <= r.top + LANE_EDGE_PX) return { insertBefore: i };
      if (clientY >= r.bottom - LANE_EDGE_PX) return { insertBefore: i + 1 };
      return { row: i };
    }
  }
  return { row: tracks.value.length }; // below the last lane → new bottom row
}

function onBlockPointerDown(e: PointerEvent, channel: string): void {
  if (e.button !== 0) return;
  focusBlock(channel);
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  drag.value = { channel, pointerId: e.pointerId, y: e.clientY, targetRow: -1, insertBefore: null, colliding: false };
}
function onBlockPointerMove(e: PointerEvent): void {
  const d = drag.value;
  if (!d || e.pointerId !== d.pointerId) return;
  const target = dropTargetAtY(e.clientY);
  d.y = e.clientY;
  if ("insertBefore" in target) {
    d.insertBefore = target.insertBefore;
    d.targetRow = -1;
    d.colliding = false; // a fresh row never collides
  } else {
    d.insertBefore = null;
    d.targetRow = target.row;
    d.colliding = dropCollides(tracks.value, blocks.value, d.channel, target.row);
  }
  drag.value = { ...d };
}
function onBlockPointerUp(e: PointerEvent): void {
  const d = drag.value;
  if (!d || e.pointerId !== d.pointerId) return;
  drag.value = null;
  if (d.insertBefore != null) {
    // Insert as a NEW track at the boundary — empty rows drop inside.
    tracks.value = insertBlockAt(tracks.value, blocks.value, d.channel, d.insertBefore);
    persist();
    return;
  }
  const currentRow = tracks.value.findIndex((r) => r.includes(d.channel));
  // Snap back (no-op) on collision or a drop onto the same row.
  if (d.targetRow < 0 || d.targetRow === currentRow || d.colliding) return;
  tracks.value = moveBlock(tracks.value, blocks.value, d.channel, d.targetRow);
  persist();
}

// --- divider drag (snap; min preview height; collapse drawer) ------
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
/** The transport bar's collapse/expand chevron — the bar
 *  stays visible either way, so this just folds the tracks below it away. */
function toggleCollapse(): void {
  if (timelineCollapsed.value) expandTimeline();
  else collapseTimeline();
}
const previewFlex = computed(() =>
  timelineCollapsed.value ? "1 1 auto" : `0 0 ${(split.value * 100).toFixed(2)}%`,
);

// --- tile divider resize -----------------------------------------
// A thin handle between adjacent tiles; dragging it moves the shared edge of
// that pair (sum preserved, both floored at MIN_TILE_FRACTION). deltaFrac maps
// px → fraction against the tiles-row width; live during the drag, persisted on
// release. Pointer capture on the handle keeps events flowing while tile widths
// (flex-grow) shift underneath.
const tilesEl = ref<HTMLElement | null>(null);
type TileDividerDrag = { index: number; pointerId: number; startX: number; startSizes: number[] };
const tileDividerDrag = ref<TileDividerDrag | null>(null);
function onTileDividerDown(e: PointerEvent, index: number): void {
  if (e.button !== 0) return;
  e.stopPropagation(); // don't let the tiles row read this as a reorder
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  tileDividerDrag.value = {
    index,
    pointerId: e.pointerId,
    startX: e.clientX,
    startSizes: [...effectiveTileSizes.value],
  };
}
function onTileDividerMove(e: PointerEvent): void {
  const d = tileDividerDrag.value;
  if (!d || e.pointerId !== d.pointerId || !tilesEl.value) return;
  const w = tilesEl.value.clientWidth;
  if (w <= 0) return;
  const deltaFrac = (e.clientX - d.startX) / w;
  tileSizes.value = resizeAtDivider(d.startSizes, d.index, deltaFrac);
}
function onTileDividerUp(e: PointerEvent): void {
  const d = tileDividerDrag.value;
  if (!d || e.pointerId !== d.pointerId) return;
  tileDividerDrag.value = null;
  persist();
}

// --- property panel -----------------------------------
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
    <!-- Live-capture warning banner: layout-stable
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
            <span class="count">{{ tileViewCount }} view{{ tileViewCount === 1 ? "" : "s" }}</span>
            <span v-if="!master.designated" class="hint" title="No wide/center stream designated by the recorder — master is the first frame channel">
              no wide designation
            </span>
            <div class="head-controls">
              <label
                v-if="footprintCapable"
                class="proj-toggle"
                title="Show fovea footprint projections for every stream at the playhead. Off: only the hovered/focused stream projects."
              >
                <input
                  type="checkbox"
                  :checked="showAllProjections"
                  @change="showAllProjections = ($event.target as HTMLInputElement).checked"
                />
                <span>show all projections</span>
              </label>
            </div>
          </header>
        <div
          ref="tilesEl"
          class="tiles"
          :class="{ reordering: tileDrag && tileDrag.moved }"
          @pointermove="onTileDragMove"
          @pointerup="onTileDragUp"
          @pointercancel="onTileDragUp"
        >
          <template v-for="(slot, si) in orderedSlots" :key="slotKey(slot)">
            <!-- Drop indicator BEFORE the slot the drag currently targets. -->
            <div v-if="tileDrag && tileDrag.moved && tileDrag.overIndex === si" class="tile-drop-indicator" />

            <!-- Divider between adjacent tiles: drag to resize the
                 pair. Faint at rest (borderless idiom), accent on hover; inert
                 during a reorder so it never clashes with the drop indicator. -->
            <div
              v-if="si > 0"
              class="tile-divider"
              title="Drag to resize"
              @pointerdown="onTileDividerDown($event, si - 1)"
              @pointermove="onTileDividerMove"
              @pointerup="onTileDividerUp"
              @pointercancel="onTileDividerUp"
            />

            <!-- Real tile (a track's active view). -->
            <div
              v-if="slot.kind === 'tile'"
              :ref="(el) => registerTileEl(el as Element | null, si)"
              class="tile"
              :class="{
                highlight: tileHighlighted(slot.tile),
                focused: tileFocused(slot.tile),
                dragging: tileDrag && tileDrag.moved && tileDrag.fromIndex === si,
              }"
              :style="{ flex: tileFlex(si), '--track-color': slotColor(slot) }"
              tabindex="0"
              title="Click to focus · drag the header to reorder · right-click for stream stats"
              @pointerenter="setHover(slot.tile.channels)"
              @pointerleave="clearHover"
              @focus="focusTile(slot.tile)"
              @click="focusTile(slot.tile)"
              @contextmenu="onTileContextMenu($event, slot.tile)"
            >
              <div
                class="tile-head drag-handle"
                :style="{ '--track-color': slotColor(slot) }"
                title="Drag to reorder tiles"
                @pointerdown="onTileDragDown($event, si)"
              >
                <span class="chip" />
                <span class="tile-name" :class="{ master: slot.tile.kind === 'single' && isMasterChannel(slot.tile.channel) }">
                  {{ tileLabel(slot.tile) }}
                </span>
              </div>
              <div class="tile-body">
                <FrameView
                  v-if="tileMat(slot.tile)"
                  :mat="tileMat(slot.tile)!"
                  width="100%"
                  height="100%"
                  :theme="slotColor(slot)"
                  :projection="{
                    source: { kind: 'viewer', recording: basename, tileKey: tileKeyOf(slot.tile) },
                    title: tileLabel(slot.tile),
                    theme: slotColor(slot),
                  }"
                >
                  <template v-if="slot.tile.kind === 'single'">
                    <g v-for="box in overlayBoxesFor(slot.tile.channel)" :key="box.topic">
                      <rect
                        :x="box.bbox.x" :y="box.bbox.y" :width="box.bbox.width" :height="box.bbox.height"
                        :stroke="TARGET_COLORS[box.index % TARGET_COLORS.length]" stroke-width="3" fill="none"
                      />
                    </g>
                    <!-- Fovea footprint projections (color-coded by pair; hover =
                         timeline block hover; label carries stream id + pair depth). -->
                    <!-- pointerleave RESTORES the containing tile's hover — the
                         tile's own pointerenter doesn't re-fire when the pointer
                         moves from a child back onto the parent, so a bare
                         clearHover stranded the tile un-highlighted. -->
                    <g
                      v-for="fp in footprintBoxesFor(slot.tile.channel)"
                      :key="'fp:' + fp.stream"
                      class="footprint"
                      :class="{ highlighted: fp.highlighted }"
                      @pointerenter="setHover([fp.stream])"
                      @pointerleave="setHover(slot.tile.channels)"
                    >
                      <polygon
                        :points="fp.points"
                        :stroke="fp.color"
                        :stroke-width="fp.highlighted ? footprintStroke * 1.7 : footprintStroke"
                        :fill="fp.color"
                        :fill-opacity="fp.highlighted ? 0.14 : 0.06"
                      />
                      <text
                        :x="fp.label.x + footprintFontSize * 0.4"
                        :y="fp.label.y - footprintFontSize * 0.4"
                        class="footprint-label"
                        :font-size="footprintFontSize"
                        :stroke-width="footprintStroke"
                        :fill="fp.color"
                      >{{ footprintLabel(fp) }}</text>
                    </g>
                  </template>
                </FrameView>
                <div v-else class="tile-placeholder" title="This stream spans the playhead but no frame has decoded here yet — play or scrub">
                  waiting for frame…
                </div>
              </div>
            </div>

            <!-- Placeholder slot (empty/disabled/pair-collapsed track) — subdued,
                 non-interactive except as a reorder drop target. -->
            <div
              v-else
              :ref="(el) => registerTileEl(el as Element | null, si)"
              class="tile placeholder"
              :style="{ flex: tileFlex(si), '--track-color': slotColor(slot) }"
            >
              <div class="tile-head" :style="{ '--track-color': slotColor(slot) }">
                <span class="chip" />
                <span class="tile-tag">{{ trackTag(slot.track) }}</span>
                <span class="tile-name">{{ placeholderLabel(slot) }}</span>
              </div>
              <div class="tile-body">
                <div class="tile-placeholder">{{ placeholderReason(slot) }}</div>
              </div>
            </div>
          </template>
          <!-- Trailing drop indicator (append to the end). -->
          <div v-if="tileDrag && tileDrag.moved && tileDrag.overIndex === orderedSlots.length" class="tile-drop-indicator" />
          <div v-if="orderedSlots.length === 0" class="notice">
            No tracks to preview.
          </div>
          </div>
        </section>

        <!-- ===== PROPERTY PANEL (focused-stream inspector) ===== -->
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

      <!-- ===== TRANSPORT BAR (the draggable divider) =====
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
          @wheel="onTracksWheel"
        >
          <!-- Bleed strips: dimmed hatched areas outside [0,duration],
               marking the recording boundaries; they pan/zoom with the content. -->
          <div v-if="bleedBeforePct > 0" class="bleed before" :style="{ width: bleedBeforePct + '%' }" />
          <div v-if="bleedAfterPct < 100" class="bleed after" :style="{ left: bleedAfterPct + '%' }" />

          <!-- Time ruler: absolute overlay at the top; click/drag seeks. -->
          <div
            class="ruler"
            @pointerdown="onRulerDown"
            @pointermove="onRulerMove"
            @pointerup="onRulerUp"
            @pointercancel="onRulerUp"
          >
            <span
              v-for="t in rulerT"
              :key="t.ns"
              class="tick"
              :class="{ major: t.major }"
              :style="{ left: fracPct(t.ns) }"
            >
              <span v-if="t.label" class="tick-label">{{ t.label }}</span>
            </span>
          </div>

          <!-- Draggable playhead: a wide invisible hit strip around
               the 1px line, split by hourglass-half ornaments — solid
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
          <template v-for="(row, ri) in tracks" :key="ri">
            <!-- Between-lane insertion indicator, shown during a drag. -->
            <div v-if="drag && drag.insertBefore === ri" class="lane-insert" />
            <div
              class="lane"
              :class="{ 'drop-ok': drag && drag.targetRow === ri && !drag.colliding, 'drop-bad': drag && drag.targetRow === ri && drag.colliding }"
              :style="{ '--track-color': laneColor(row, ri) }"
              :ref="(el) => registerLane(el as Element | null, ri)"
              @pointerdown="(e) => seekFromClientX(e.clientX, e.currentTarget as HTMLElement)"
            >
              <span class="lane-tag">{{ trackTag(ri) }}</span>
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
          </template>
          <!-- Insertion indicator at the very bottom boundary. -->
          <div v-if="drag && drag.insertBefore === tracks.length" class="lane-insert" />
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

    <!-- ===== confirm dialog (corrupt / mismatch) ===== -->
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

// Live-capture banner: a flex child at the top of `.main`, so it
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
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 0.3ch;
    padding: 0 0.4ch;
    &:hover { color: var(--text); background: var(--tint-2); }
    &:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  }
}

// no resting border — a faint fill reads as interactive; stronger on
// hover. (This is a secondary action; the danger/primary buttons keep fill.)
.panel-export {
  margin-left: auto;
  align-self: center;
  background: transparent;
  border: none;
  color: var(--text-dim);
  border-radius: 0.3ch;
  padding: 0.15rem 0.6ch;
  cursor: pointer;
  font-size: var(--fs-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
  &:hover { color: var(--text-bright); background: var(--tint-2); }
  &:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
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
    .proj-toggle {
      display: flex;
      align-items: center;
      gap: 0.5ch;
      color: var(--text-faint);
      cursor: pointer;
    }
  }

  // --- fovea footprint overlay (drawn in the master tile's annotations svg) ---
  // The svg itself is pointer-events:none (FrameView); footprint groups opt back
  // in so hover links to the timeline. Labels get a dark stroke HALO (paint-order
  // stroke) so they stay legible over video. Instant, layout-stable (no anim).
  .footprint {
    pointer-events: auto;
    cursor: pointer;
    polygon {
      stroke-linejoin: round;
    }
  }
  .footprint-label {
    font-family: var(--font-mono);
    paint-order: stroke;
    stroke: rgba(0, 0, 0, 0.85);
    stroke-linejoin: round;
    pointer-events: none;
    user-select: none;
    dominant-baseline: text-after-edge;
  }

  .tiles {
    flex-grow: 1;
    display: flex;
    flex-direction: row;
    width: 100%;
    padding: 0.5em;
    // the tiles row ALWAYS fills 100% and never scrolls — widths are
    // flex-grow fractions, dividers carve the pairs.
    overflow: hidden;
    min-height: 0;
    // While a tile reorder is in progress, the grabbed header reads as grabbing.
    &.reordering .tile.dragging {
      opacity: 0.55;
    }
    // Dividers are inert mid-reorder so they never clash with the drop indicator.
    &.reordering .tile-divider {
      pointer-events: none;
    }
  }

  // Divider handle between two adjacent tiles: a few px, faint at
  // rest per the borderless idiom, accent + grab cursor on hover/drag.
  .tile-divider {
    flex: 0 0 6px;
    align-self: stretch;
    margin: 0.2em 0;
    border-radius: 3px;
    cursor: col-resize;
    touch-action: none;
    background: var(--tint-1);
    opacity: 0.4;
    transition: none; // SNAP feedback, no animated width
    &:hover,
    &:active {
      background: var(--accent-bright);
      opacity: 1;
    }
  }

  // Vertical accent line marking where a dragged tile will drop.
  // SNAP: instant; a thin flex child so it never overlaps neighbor content.
  .tile-drop-indicator {
    flex: 0 0 2px;
    align-self: stretch;
    margin: 0.2em 0;
    background: var(--accent-bright);
    border-radius: 1px;
  }

  .tile {
    // Width = flex-grow fraction; the flex shorthand is bound inline
    // (`tileFlex`). min-width:0 lets a tile shrink below its content on resize.
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-canvas);
    // Borderless at rest: a faint track-hue outline
    // that RAISES on highlight/focus rather than a loud constant border.
    border: 1px solid transparent;
    border-radius: 4px;
    overflow: hidden;
    outline: none;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--track-color, var(--tint-2)) 22%, transparent);
    // Cross-highlight: track-hue box-shadow ring — visible, never
    // reflows. SNAP: instant on/off, no transition on this feedback path.
    &.highlight {
      box-shadow: 0 0 0 2px var(--track-color, var(--accent-bright));
    }
    // Focused tile gets the stronger track-hue outline (matches focused blocks).
    &.focused {
      outline: 2px solid var(--track-color, var(--accent));
      outline-offset: -2px;
    }
    // Placeholder slot (empty/disabled/pair-collapsed track): subdued, no video.
    &.placeholder {
      background: var(--bg-panel-alt);
      border-style: dashed;
      opacity: 0.8;
    }

    .tile-head {
      display: flex;
      align-items: center;
      gap: 0.5ch;
      padding: 0.2em 0.6em;
      font-size: 0.78em;
      color: var(--text-dim);
      background: var(--bg-panel-alt);
      border-bottom: 1px solid var(--tint-1);
      white-space: nowrap;
      overflow: hidden;
      // Track-hue chip: a small color swatch keyed to the lane hue.
      .chip {
        flex: 0 0 auto;
        width: 0.7ch;
        height: 0.7ch;
        border-radius: 2px;
        background: var(--track-color, transparent);
      }
      .tile-tag {
        flex: 0 0 auto;
        color: var(--text-faint);
        font-family: var(--font-mono);
      }
      .tile-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tile-name.master {
        color: var(--accent-bright);
        font-weight: 600;
      }
      // The real-tile header is the reorder drag handle.
      &.drag-handle {
        cursor: grab;
        touch-action: none;
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
    &.placeholder .tile-body {
      background: transparent;
    }
    .tile-placeholder {
      color: var(--text-disabled);
      font-size: 0.85em;
      text-align: center;
      padding: 0 0.6em;
    }
  }
}

// ---- property panel (focused-stream inspector) ----
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

// ---- transport bar (the draggable divider) ----
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

  // inline controls carry NO resting border/outline — a
  // faint element background reads as the interactive surface, darker on hover,
  // stronger while active. :focus-visible outlines stay for a11y.
  .play {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--text-strong);
    border: none;
    border-radius: 4px;
    padding: 0.3em 0;
    width: 2.6em;
    cursor: pointer;
    &:hover {
      background: var(--tint-2);
    }
    &:active {
      background: var(--tint-4);
    }
    &:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
  }
  select {
    background: transparent;
    color: var(--text-dim);
    border: none;
    border-radius: 3px;
    padding: 0.15em 0.3ch;
    cursor: pointer;
    &:hover {
      background: var(--tint-2);
    }
    &:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
  }
  .threed-global {
    display: flex;
    align-items: center;
    gap: 0.6ch;
    color: var(--text-faint);
    font-size: 0.85em;
  }
  .bar-btn {
    background: transparent;
    color: var(--text-strong);
    border: none;
    border-radius: 4px;
    padding: 0.3em 0.55em;
    cursor: pointer;
    &:hover {
      background: var(--tint-2);
    }
    &:active {
      background: var(--tint-4);
    }
    &:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    // Active (panel open) — accent color + a faint fill; no border.
    &.active {
      color: var(--accent-bright);
      background: var(--tint-3);
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
    overflow-x: hidden;
    // Top padding reserves the ruler strip's height.
    padding: 1.5em 0 0.4em;
    min-height: 0;

    // Bleed strips: dimmed hatched areas outside [0,duration]. They
    // sit BEHIND lanes (z 0) and mark where the recording has no content.
    .bleed {
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: 0;
      pointer-events: none;
      background-color: #0000;
      background-image: repeating-linear-gradient(
        45deg,
        var(--tint-2) 0,
        var(--tint-2) 1px,
        transparent 1px,
        transparent 7px
      );
      opacity: 0.6;
      &.before { left: 0; }
      &.after { right: 0; }
    }

    // Time ruler: absolute overlay strip at the very top, above lanes
    // and below the playhead. Click/drag anywhere on it seeks.
    .ruler {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 1.5em;
      z-index: 4;
      cursor: ew-resize;
      border-bottom: 1px solid var(--tint-1);
      background: var(--bg-chrome);
      .tick {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 0;
        border-left: 1px solid var(--tint-2);
        &.major {
          border-left-color: var(--border-muted);
        }
        .tick-label {
          position: absolute;
          left: 0.3ch;
          top: 0.1em;
          font-size: 0.62em;
          color: var(--text-faint);
          font-family: var(--font-mono);
          white-space: nowrap;
          pointer-events: none;
        }
      }
    }

    // Insertion indicator between lanes — an accent bar shown while a
    // block drag hovers a lane boundary. SNAP: instant.
    .lane-insert {
      height: 3px;
      margin: 0 0.6em;
      border-radius: 2px;
      background: var(--accent-bright);
      position: relative;
      z-index: 3;
    }

    // Draggable playhead: a WIDE invisible hit strip (14px) around
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
      // Track hue: a subtle left accent bar, NOT a loud fill.
      border-left: 3px solid var(--track-color, var(--tint-1));
      border-radius: 4px;
      background: #ffffff06;
      overflow: hidden; // clip blocks panned/zoomed outside the viewport
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
        border-left-color: var(--tint-1);
      }
      .lane-tag {
        position: absolute;
        left: 0.5ch;
        top: 0.2em;
        font-size: 0.68em;
        // Tinted by the track hue; still legible.
        color: var(--track-color, var(--text-disabled));
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
      // Track hue: the block edge picks up its lane's color; still a
      // tint, not a loud fill.
      border: 1px solid var(--track-color, #4a6a8a);
      border-radius: 3px;
      color: #dfe8f0;
      font-size: 0.8em;
      overflow: hidden;
      cursor: grab;
      touch-action: none;
      // Instant hover/focus cues (no transition on the control path).
      &:hover {
        border-color: var(--accent-bright);
      }
      &.master {
        background: #23405a;
        border-color: var(--accent-bright);
      }
      &.focused {
        outline: 2px solid var(--accent);
        outline-offset: 0;
      }
      // Cross-highlight: box-shadow ring — instant, no reflow.
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
      // SECONDARY buttons are borderless (faint fill on hover); the
      // PRIMARY/destructive action keeps emphasis via a solid fill, not a border.
      button {
        background: transparent;
        color: var(--text-strong);
        border: none;
        border-radius: 4px;
        padding: 0.35em 1.1em;
        cursor: pointer;
        &:hover {
          background: var(--tint-2);
        }
        &:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
        &.danger {
          background: var(--danger);
          color: #fff;
          &:hover {
            background: var(--danger-strong);
          }
        }
      }
    }
  }
}

// ---- title-bar buttons (icon-only) ----
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
