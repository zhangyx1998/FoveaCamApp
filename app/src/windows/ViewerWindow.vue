<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  STANDALONE recorder viewer window (standalone-viewer-and-fcap ruling 1;
  formerly A-11 over the C-8 `viewer` session, both retired): playback UI for
  one `.fcap`/`.fovea` file, fully self-contained in this window. The data
  layer (MCAP read + core-Vision decode + timestamp-paced playback) runs on a
  worker thread INSIDE this window's process (src/viewer/worker.ts), spawned
  by the dedicated viewer preload — the orchestrator is never involved, so
  playback keeps working while it is down, busy, or restarting.

  Wire-up: this component creates a DOM MessageChannel, keeps port1, and
  hands port2 to the preload via `window.postMessage({kind: VIEWER_INIT})`
  (the SHM_INIT pattern — see src/viewer/protocol.ts). Decoded Mats arrive
  with transferred buffers and render through FrameView's ImageData path
  directly — no SHM hop, no frame transport. All playback state
  (position/playing/docs) is window-local.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { Mat } from "core/Vision";
import {
  VIEWER_INIT,
  type PlaybackDoc,
  type ViewerChannelInfo,
  type ViewerCommand,
  type ViewerEvent,
  type ViewerFileInfo,
} from "../viewer/protocol";
import TitleBar from "../components/TitleBar.vue";
import FrameView from "../components/FrameView.vue";

const props = defineProps<{ path: string }>();

const titleBarHeight = ref(0);

// --- worker link (window-local playback state) ------------------------------

const file = ref<ViewerFileInfo | null>(null);
const openError = ref<string | null>(null);
const playing = ref(false);
const workerPositionNs = ref(0);
/** Latest descriptor doc per `fovea/<target>` topic (overlay data). Reset on
 *  seek BEFORE the command goes out, so a backwards scrub can't leave a
 *  future bbox on screen (the worker's latest-before republish repopulates
 *  whatever exists at the new position — the retired session's semantics). */
const descriptors = ref<Record<string, PlaybackDoc>>({});
/** Latest decoded Mat per frame channel. A plain Map + tick (not a reactive
 *  Map): frames arrive at playback rate and only the selected channel needs
 *  a re-render. */
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
      break;
    case "open-error":
      openError.value = ev.message;
      break;
    case "position":
      workerPositionNs.value = ev.positionNs;
      playing.value = ev.playing;
      break;
    case "telemetry":
      // Per-frame extras doc (volt/angle/affine) — not surfaced in this UI
      // yet; kept in the protocol for the metadata inspector to come.
      break;
    case "descriptor":
      descriptors.value = { ...descriptors.value, [ev.topic]: ev.doc };
      break;
    case "frame": {
      const mat = Object.assign(
        new Uint8Array(ev.buffer, ev.byteOffset, ev.length),
        { shape: ev.shape, channels: ev.channels },
      ) as Mat<Uint8Array>;
      mats.set(ev.channel, mat);
      frameTick.value++;
      break;
    }
    case "error":
      console.error("[viewer]", ev.message);
      break;
  }
};
// Hand the sibling port to the preload — it spawns the playback worker and
// relays verbatim (frame buffers re-transferred, never copied).
window.postMessage({ kind: VIEWER_INIT }, "*", [link.port2]);

onMounted(() => {
  if (!props.path) {
    openError.value = "Missing file path (?path=…)";
    return;
  }
  send({ type: "open", path: props.path });
});

// Best-effort explicit close (releases the file handle promptly); the preload
// terminates the worker on pagehide as the backstop, and the whole worker
// dies with this window's process in every crash path.
function onPageHide(): void {
  send({ type: "close" });
}
window.addEventListener("pagehide", onPageHide);
onUnmounted(() => window.removeEventListener("pagehide", onPageHide));

const basename = computed(() => props.path.split(/[/\\]/).pop() ?? props.path);

// UX 4 (standalone-viewer-and-fcap): a COMPACT path for the subtitle + sidebar
// — the home directory collapsed to `~`, LEFT-ellipsized (CSS `direction: rtl`)
// so the filename end stays visible while the leading dirs truncate. The full
// path stays in the tooltip (`title`). Home collapse is a renderer-side
// heuristic (no node in the window): `/Users/<u>`, `/home/<u>`, `C:\Users\<u>`.
const compactPath = computed(() =>
  props.path.replace(
    /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/,
    "~",
  ),
);

function openFolder(): void {
  // UX 5: reveal the current recording in Finder/Explorer (main brokers
  // shell.showItemInFolder). The full, un-collapsed path is what the OS needs.
  void window.foveaBridge?.revealRecording?.(props.path);
}

// --- tracks ---------------------------------------------------------------

// The §2b telemetry channel is JSON (per-frame extras), not pixels — listed
// as a track but not selectable for display; descriptor (`fovea/<n>`) tracks
// are json too and draw as overlays instead.
const isVisual = (c: ViewerChannelInfo) => c.metadata.messageEncoding !== "json";
const selected = ref<string | null>(null);
const selectedChannel = computed(() => {
  const channels = file.value?.channels ?? [];
  if (selected.value && channels.some((c) => c.name === selected.value && isVisual(c)))
    return selected.value;
  return channels.find(isVisual)?.name ?? null;
});

const displayMat = computed(() => {
  void frameTick.value; // re-evaluate on every delivered frame
  return selectedChannel.value ? (mats.get(selectedChannel.value) ?? null) : null;
});

// --- descriptor overlay (multi-fovea recordings, wave I-2 ruling 6) --------
// `fovea/<target>` tracks carry `{tNs, bbox, frames}` observation docs whose
// bbox is in WIDE (center-stream) coordinates. The worker replays them
// latest-wins (nearest-sample at playback rate; scrub redraw repopulates the
// latest-before doc), so the overlay just draws the current doc per target
// whenever the wide stream is the one displayed.
const TARGET_COLORS = [
  "#00aaff", "#ffb000", "#36d16f", "#ff5b8a",
  "#b983ff", "#00d5c7", "#ff7a35", "#d6e04f",
];
type OverlayBox = { topic: string; index: number; bbox: { x: number; y: number; width: number; height: number } };
const overlayBoxes = computed<OverlayBox[]>(() => {
  if (selectedChannel.value !== "center") return [];
  const out: OverlayBox[] = [];
  for (const [topic, doc] of Object.entries(descriptors.value)) {
    const bbox = (doc as { bbox?: OverlayBox["bbox"] }).bbox;
    if (!bbox || typeof bbox.x !== "number") continue;
    const index = Number(topic.split("/").pop());
    out.push({ topic, index: Number.isFinite(index) ? index : 0, bbox });
  }
  return out;
});
const overlayStroke = computed(() => {
  const w = overlayBoxes.value.reduce((m, b) => Math.max(m, b.bbox.x + b.bbox.width), 0);
  return Math.max(2, w * 0.003);
});

// --- transport controls -----------------------------------------------------

const RATES = [0.25, 0.5, 1, 2, 4];
const rate = ref(1);

function togglePlay(): void {
  if (!file.value) return;
  if (playing.value) send({ type: "pause" });
  else send({ type: "play", rate: rate.value });
}

function setRate(event: Event): void {
  rate.value = Number((event.target as HTMLSelectElement).value);
  // Re-issue play at the new rate if currently playing.
  if (playing.value) send({ type: "play", rate: rate.value });
}

// Scrub: while dragging, the slider shows the local value (the worker's
// `positionNs` echo would fight the thumb); seeks are sent live while
// dragging (commands are cheap) and the local override lifts on release.
const scrubbing = ref(false);
const scrubNs = ref(0);
const positionNs = computed(() =>
  scrubbing.value ? scrubNs.value : workerPositionNs.value,
);

function onScrub(event: Event): void {
  const tNs = Number((event.target as HTMLInputElement).value);
  scrubbing.value = true;
  scrubNs.value = tNs;
  descriptors.value = {}; // reset-on-seek — see the `descriptors` doc above
  send({ type: "seek", tNs });
}

function onScrubEnd(): void {
  scrubbing.value = false;
}

function fmtNs(ns: number): string {
  const totalMs = Math.max(0, Math.round(ns / 1e6));
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <div v-if="openError" class="notice">{{ openError }}</div>
    <div v-else-if="!file" class="notice">Opening {{ basename }}…</div>
    <template v-else>
      <div class="tracks">
        <div class="file-info">
          <div class="name" :title="file.path">{{ basename }}</div>
          <div class="path left-ellipsis" :title="file.path" dir="ltr">{{ compactPath }}</div>
          <div v-if="file.truncated" class="truncated" title="File was footerless (crash-truncated); recovered via re-index">
            recovered (truncated)
          </div>
        </div>
        <div
          v-for="c in file.channels"
          :key="c.name"
          class="track"
          :class="{ selected: c.name === selectedChannel, visual: isVisual(c) }"
          @click="isVisual(c) && (selected = c.name)"
        >
          <div class="track-name">{{ c.name }}</div>
          <div class="track-meta">
            <span v-for="(v, k) in c.metadata" :key="k">{{ k }}={{ v }}</span>
          </div>
        </div>
      </div>
      <div class="stage">
        <div class="display">
          <FrameView v-if="displayMat" :mat="displayMat" width="100%" height="100%">
            <g v-for="box in overlayBoxes" :key="box.topic">
              <rect
                :x="box.bbox.x"
                :y="box.bbox.y"
                :width="box.bbox.width"
                :height="box.bbox.height"
                :stroke="TARGET_COLORS[box.index % TARGET_COLORS.length]"
                :stroke-width="overlayStroke"
                fill="none"
              />
              <text
                :x="box.bbox.x + overlayStroke * 2"
                :y="box.bbox.y - overlayStroke * 2"
                :fill="TARGET_COLORS[box.index % TARGET_COLORS.length]"
                :font-size="overlayStroke * 8"
                font-weight="700"
                paint-order="stroke"
                stroke="#000"
                :stroke-width="overlayStroke"
              >
                {{ box.index + 1 }}
              </text>
            </g>
          </FrameView>
          <div v-else class="notice">No frames on {{ selectedChannel ?? "…" }} yet — press play or scrub</div>
        </div>
        <div class="transport">
          <button class="play" @click="togglePlay">
            {{ playing ? "⏸" : "▶" }}
          </button>
          <select :value="rate" @change="setRate" title="Playback rate">
            <option v-for="r in RATES" :key="r" :value="r">{{ r }}×</option>
          </select>
          <span class="time">{{ fmtNs(positionNs) }}</span>
          <input
            class="timeline"
            type="range"
            :min="0"
            :max="file.durationNs"
            :value="positionNs"
            @input="onScrub"
            @change="onScrubEnd"
            @pointerup="onScrubEnd"
          />
          <span class="time">{{ fmtNs(file.durationNs) }}</span>
        </div>
      </div>
    </template>
  </div>
  <TitleBar title="Viewer" :subtitle="compactPath" @height="(h) => (titleBarHeight = h)">
    <!-- UX 5: right-side "Open folder" button reveals the current file. -->
    <button
      v-if="file"
      class="open-folder"
      title="Reveal this recording in Finder/Explorer"
      @click="openFolder"
    >
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
  flex-direction: row;
  overflow: hidden;
  * {
    user-select: none;
  }
}

.notice {
  color: #888;
  font-size: 1.1em;
  text-align: center;
  padding: 2em;
  flex-grow: 1;
}

// UX 5: "Open folder" button in the title-bar actions slot (no-drag region).
.open-folder {
  background: #222;
  color: #ccc;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 0.25em 0.9em;
  font-size: 0.85em;
  cursor: pointer;
  white-space: nowrap;
  &:hover {
    background: #2a2a2a;
    color: #fff;
  }
}

.tracks {
  width: 30ch;
  min-width: 24ch;
  background: #161616;
  border-right: 1px solid #fff2;
  overflow-y: auto;

  .file-info {
    padding: 0.8em 1em;
    border-bottom: 1px solid #fff2;
    .name {
      color: #ddd;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    // UX 4: compact path, LEFT-ellipsized (rtl direction pushes the overflow +
    // ellipsis to the start, keeping the filename tail visible). `dir="ltr"` on
    // the element keeps the path text itself in reading order.
    .path {
      margin-top: 0.25em;
      color: #777;
      font-size: 0.78em;
      font-family: monospace;
    }
    .left-ellipsis {
      direction: rtl;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .truncated {
      display: inline-block;
      margin-top: 0.4em;
      color: #fa0;
      border: 1px solid #fa06;
      border-radius: 3px;
      padding: 0 0.5em;
      font-size: 0.8em;
    }
  }

  .track {
    padding: 0.6em 1em;
    border-bottom: 1px solid #fff1;
    border-left: 0.5ch solid transparent;
    color: #999;

    &.visual {
      cursor: pointer;
      color: #ccc;
      &:hover {
        background: #fff1;
      }
    }
    &.selected {
      border-left-color: #0af;
      background: #fff1;
    }

    .track-name {
      font-weight: 500;
    }
    .track-meta {
      margin-top: 0.2em;
      font-size: 0.75em;
      color: #777;
      display: flex;
      flex-wrap: wrap;
      gap: 0.3em 1ch;
    }
  }
}

.stage {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;

  .display {
    flex-grow: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #111;
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 1ch;
    padding: 0.6em 1em;
    border-top: 1px solid #fff2;
    background: #161616;

    .play {
      background: #222;
      color: #ddd;
      border: 1px solid #333;
      border-radius: 4px;
      width: 3em;
      padding: 0.3em 0;
      cursor: pointer;
      &:hover {
        background: #2a2a2a;
      }
    }

    select {
      background: #111;
      color: #ccc;
      border: 1px solid #444;
      border-radius: 3px;
    }

    .time {
      color: #999;
      font-family: monospace;
      font-size: 0.85em;
      min-width: 9ch;
      text-align: center;
    }

    .timeline {
      flex-grow: 1;
    }
  }
}
</style>
