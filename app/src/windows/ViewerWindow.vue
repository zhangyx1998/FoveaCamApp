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
  VIEWER_INIT,
  type PlaybackDoc,
  type ViewerChannelInfo,
  type ViewerCommand,
  type ViewerEvent,
  type ViewerFileInfo,
} from "../viewer/protocol";
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
  reconcileLayout,
  THREE_D_MODES,
  type ChannelBlock,
  type ThreeDMode,
  type Tile,
} from "../viewer/timeline";
import {
  COLLAPSED_SPLIT,
  DEFAULT_SPLIT,
  DEFAULT_TILE_WIDTH,
  MAX_SPLIT,
  MAX_TILE_WIDTH,
  MIN_SPLIT,
  MIN_TILE_WIDTH,
  type SidecarLoad,
  type SidecarState,
} from "../viewer/sidecar";
import TitleBar from "../components/TitleBar.vue";
import FrameView from "../components/FrameView.vue";

const props = defineProps<{ path: string }>();

const titleBarHeight = ref(0);

// --- worker link (window-local playback state) ------------------------------

const file = ref<ViewerFileInfo | null>(null);
const openError = ref<string | null>(null);
const playing = ref(false);
const workerPositionNs = ref(0);
const descriptors = ref<Record<string, PlaybackDoc>>({});
/** Latest decoded Mat per frame channel — plain Map + a tick (frames arrive at
 *  playback rate; the tiles that actually changed re-render off the tick). */
const mats = new Map<string, Mat<Uint8Array>>();
const frameTick = ref(0);

const link = new MessageChannel();
const port = link.port1;
function send(cmd: ViewerCommand): void {
  port.postMessage(cmd);
}

port.onmessage = (e: MessageEvent) => {
  const ev = e.data as ViewerEvent;
  switch (ev?.type) {
    case "opened":
      file.value = ev.info;
      applySidecar(ev.sidecar);
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
    case "frame": {
      const mat = Object.assign(new Uint8Array(ev.buffer, ev.byteOffset, ev.length), {
        shape: ev.shape,
        channels: ev.channels,
      }) as Mat<Uint8Array>;
      mats.set(ev.channel, mat);
      frameTick.value++;
      break;
    }
    case "error":
      console.error("[viewer]", ev.message);
      break;
  }
};
window.postMessage({ kind: VIEWER_INIT }, "*", [link.port2]);

onMounted(() => {
  if (!props.path) {
    openError.value = "Missing file path (?path=…)";
    return;
  }
  send({ type: "open", path: props.path });
});

function onPageHide(): void {
  send({ type: "close" }); // flushes the pending sidecar write worker-side
}
window.addEventListener("pagehide", onPageHide);
window.addEventListener("keydown", onKeydown);
onUnmounted(() => {
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("keydown", onKeydown);
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
const threeD = ref<Record<string, ThreeDMode>>({}); // pair base → mode
const split = ref<number>(DEFAULT_SPLIT); // preview height fraction
const tileWidth = ref<number>(DEFAULT_TILE_WIDTH);
const initialized = ref(false);
/** Non-null while a confirm dialog is up (ruling 10 — corrupt/mismatch). */
const confirmReset = ref<null | { reason: "corrupt" | "mismatch" }>(null);

/** pair-membership lookup: channel → {pair, mode}. */
const pairModeOf = computed(() => {
  const m = new Map<string, { pair: (typeof pairs.value)[number]; mode: ThreeDMode }>();
  for (const p of pairs.value) {
    const mode = threeD.value[p.base] ?? "disabled";
    m.set(p.left, { pair: p, mode });
    m.set(p.right, { pair: p, mode });
  }
  return m;
});

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
  threeD.value = {};
  split.value = DEFAULT_SPLIT;
  tileWidth.value = DEFAULT_TILE_WIDTH;
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
  threeD.value = { ...st.threeD };
  split.value = st.split;
  tileWidth.value = st.tileWidth;
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
function onScrub(event: Event): void {
  seekTo(Number((event.target as HTMLInputElement).value));
}
function onScrubEnd(): void {
  scrubbing.value = false;
  persist();
}
/** Click-to-seek on the timeline ruler/track background (snap). */
function seekFromClientX(clientX: number, el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || durationNs.value <= 0) return;
  const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  seekTo(frac * durationNs.value);
  scrubbing.value = false;
}

function fmtNs(ns: number): string {
  const totalMs = Math.max(0, Math.round(ns / 1e6));
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

// --- preview tiles ----------------------------------------------------------

const orderedActive = computed(() =>
  activeChannels(tracks.value, blocks.value, positionNs.value, enabledSet.value),
);
const tiles = computed<Tile[]>(() => composeTiles(orderedActive.value, pairModeOf.value));

/** Standard red/cyan anaglyph: RED channel from the LEFT eye, GREEN+BLUE from
 *  the RIGHT eye, merged renderer-side into a fresh 3-channel RGB Mat (no core
 *  dependency, ruling 4). Channel 0 is treated as R in RGB order; grayscale
 *  (1ch) broadcasts. Uses the min of the two frames' dims when they differ. */
function anaglyph(l: Mat<Uint8Array>, r: Mat<Uint8Array>): Mat<Uint8Array> {
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
      out[oi] = l[li]!; // R ← left
      out[oi + 1] = rc === 1 ? r[ri]! : r[ri + 1]!; // G ← right
      out[oi + 2] = rc === 1 ? r[ri]! : r[ri + 2]!; // B ← right
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
  return anaglyph(l, r);
}
function tileKey(tile: Tile): string {
  return tile.kind === "single" ? tile.channel : `pair:${tile.pair.base}`;
}
function tileLabel(tile: Tile): string {
  if (tile.kind === "single") return tile.channel;
  const m = tile.mode === "anaglyph" ? "3D" : tile.mode === "left-only" ? "L" : "R";
  return `${tile.pair.base} (${m})`;
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
const modeForChannel = (channel: string) => pairModeOf.value.get(channel)?.mode ?? "disabled";
function pairBaseForChannel(channel: string): string | null {
  return pairModeOf.value.get(channel)?.pair.base ?? null;
}
function set3DMode(base: string, mode: ThreeDMode): void {
  threeD.value = { ...threeD.value, [base]: mode };
  persist();
}

// --- v-toggle (ruling 5): focused block + `v` toggles the stream ------------
const focused = ref<string | null>(null);
function focusBlock(channel: string): void {
  focused.value = channel;
}
function toggleDisabled(channel: string): void {
  const next = new Set(disabled.value);
  if (next.has(channel)) next.delete(channel);
  else next.add(channel);
  disabled.value = next;
  persist();
}
function onKeydown(e: KeyboardEvent): void {
  // Window-local; ignore modifier chords (Cmd+V etc.) and text-entry targets so
  // we don't collide with menu accelerators or the rate <select>.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  if (e.key === "v" && focused.value) {
    e.preventDefault();
    toggleDisabled(focused.value);
  }
}

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
</script>

<template>
  <div ref="mainEl" class="main" :style="{ top: titleBarHeight + 'px' }">
    <div v-if="openError" class="notice">{{ openError }}</div>
    <div v-else-if="!file" class="notice">Opening {{ basename }}…</div>
    <template v-else>
      <!-- ===== PREVIEW PANEL (tiles of active streams, Z order) ===== -->
      <section class="preview" :style="{ flex: previewFlex }">
        <header class="preview-head">
          <span class="count">{{ tiles.length }} view{{ tiles.length === 1 ? "" : "s" }}</span>
          <span v-if="!master.designated" class="hint" title="No wide/center stream designated by the recorder — master is the first frame channel">
            no wide designation
          </span>
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
        </header>
        <div class="tiles">
          <div
            v-for="tile in tiles"
            :key="tileKey(tile)"
            class="tile"
            :style="{ width: tileWidth + 'px' }"
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
              <div v-else class="tile-placeholder">no frame</div>
            </div>
          </div>
          <div v-if="tiles.length === 0" class="notice">
            No enabled stream under the playhead — press play or scrub.
          </div>
        </div>
      </section>

      <!-- ===== DIVIDER (snap drag) / collapsed drawer ===== -->
      <div v-if="timelineCollapsed" class="drawer" @click="expandTimeline" title="Show timeline">
        <span class="uparrow">▲</span> timeline
      </div>
      <template v-else>
        <div
          class="divider"
          @pointerdown="onDividerDown"
          @pointermove="onDividerMove"
          @pointerup="onDividerUp"
          @pointercancel="onDividerUp"
        />

        <!-- ===== TIMELINE PANEL ===== -->
        <section class="timeline-panel">
          <div class="transport">
            <button class="play" @click="togglePlay">{{ playing ? "⏸" : "▶" }}</button>
            <select :value="rate" @change="setRate" title="Playback rate">
              <option v-for="r in RATES" :key="r" :value="r">{{ r }}×</option>
            </select>
            <span class="time">{{ fmtNs(positionNs) }}</span>
            <input
              class="scrub" type="range" :min="0" :max="durationNs" :value="positionNs"
              @input="onScrub" @change="onScrubEnd" @pointerup="onScrubEnd"
            />
            <span class="time">{{ fmtNs(durationNs) }}</span>
            <button class="collapse" @click="collapseTimeline" title="Collapse timeline">▼</button>
          </div>

          <div
            class="tracks"
            @pointermove="onBlockPointerMove"
            @pointerup="onBlockPointerUp"
            @pointercancel="onBlockPointerUp"
          >
            <div class="playhead" :style="{ left: playheadPct + '%' }" />
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
                  disabled: disabled.has(channel),
                  master: isMasterChannel(channel),
                  dragging: drag && drag.channel === channel,
                }"
                :style="blockStyle(channel)"
                tabindex="0"
                @pointerdown.stop="(e) => onBlockPointerDown(e, channel)"
                @focus="focusBlock(channel)"
                @click.stop="focusBlock(channel)"
              >
                <span class="block-name">{{ channel }}</span>
                <select
                  v-if="pairBaseForChannel(channel) && (!pairModeOf.get(channel) || pairModeOf.get(channel)!.pair.left === channel)"
                  class="threed"
                  :value="modeForChannel(channel)"
                  title="3D View"
                  @pointerdown.stop
                  @click.stop
                  @change="(e) => set3DMode(pairBaseForChannel(channel)!, (e.target as HTMLSelectElement).value as ThreeDMode)"
                >
                  <option v-for="m in THREE_D_MODES" :key="m" :value="m">{{ m }}</option>
                </select>
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
    </template>

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
    <button v-if="file" class="tb-btn" title="Re-initialize the view layout (re-run auto-pack)" @click="resetUiState">
      Reset UI state
    </button>
    <button v-if="file" class="tb-btn" title="Reveal this recording in Finder/Explorer" @click="openFolder">
      Open folder
    </button>
  </TitleBar>
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

// ---- preview panel ----
.preview {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-chrome);
  border-bottom: 1px solid var(--tint-2);

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
    .tilew {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 0.6ch;
      color: var(--text-faint);
      input {
        width: 12ch;
      }
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

// ---- divider / drawer ----
.divider {
  height: 6px;
  flex: 0 0 6px;
  background: var(--bg-app);
  cursor: row-resize;
  // SNAP: no transition on the control path.
  &:hover {
    background: #0af6;
  }
}
.drawer {
  flex: 0 0 auto;
  padding: 0.3em 1em;
  background: var(--bg-panel-alt);
  border-top: 1px solid var(--tint-2);
  color: var(--text-muted);
  font-size: 0.85em;
  cursor: pointer;
  text-align: center;
  &:hover {
    color: var(--text);
    background: var(--bg-panel-alt);
  }
  .uparrow {
    color: var(--accent-bright);
  }
}

// ---- timeline panel ----
.timeline-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex-grow: 1;
  background: var(--bg-chrome);

  .transport {
    display: flex;
    align-items: center;
    gap: 1ch;
    padding: 0.5em 1em;
    border-bottom: 1px solid var(--tint-1);
    background: var(--bg-panel-alt);
    flex: 0 0 auto;

    .play,
    .collapse {
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
    .time {
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 0.85em;
      min-width: 9ch;
      text-align: center;
    }
    .scrub {
      flex-grow: 1;
    }
    .collapse {
      margin-left: 0.5ch;
    }
  }

  .tracks {
    position: relative;
    flex-grow: 1;
    overflow-y: auto;
    padding: 0.4em 0;
    min-height: 0;

    .playhead {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--accent-bright);
      pointer-events: none;
      z-index: 5;
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
      .threed {
        background: #111a;
        color: #cde;
        border: 1px solid #4a6a8a;
        border-radius: 3px;
        font-size: 0.9em;
        cursor: pointer;
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

// ---- title-bar buttons ----
.tb-btn {
  background: var(--bg-app);
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.25em 0.9em;
  font-size: 0.85em;
  cursor: pointer;
  white-space: nowrap;
  margin-left: 0.5ch;
  &:hover {
    background: var(--bg-elevated);
    color: var(--text);
  }
}
</style>
