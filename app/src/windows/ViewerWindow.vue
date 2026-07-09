<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Recorder viewer window (A-11, docs/history/refactor/recorder-container.md §4):
  playback UI for one `.fovea` file. Everything data-side comes from the
  PINNED `viewer` contract (`@lib/orchestrator/contracts` — C-8 implements
  the session): `open(path)` on mount, authoritative playback state in
  `state.files[fileId]`, frames consumed exactly like live streams through
  `session.frame("<fileId>:<channel>")` (one ref = one finterest, C10).

  Subscription is ACTIVE (not passive): the viewer session holds no cameras,
  and active interest gives C-8's session a meaningful activate/idle
  lifecycle (last viewer window gone → idle → close open readers). `close`
  is also sent explicitly on pagehide, best-effort — the port-close detach
  covers the crash path.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useSession } from "@lib/orchestrator/client";
import { viewer, type ViewerChannel } from "@lib/orchestrator/viewer-contract";
import TitleBar from "../components/TitleBar.vue";
import StreamView from "../components/StreamView.vue";

const props = defineProps<{ path: string }>();

const titleBarHeight = ref(0);
const session = useSession(viewer, "viewer");

const fileId = ref<string | null>(null);
const openError = ref<string | null>(null);

onMounted(async () => {
  if (!props.path) {
    openError.value = "Missing file path (?path=…)";
    return;
  }
  try {
    const result = await session.call("open", props.path);
    fileId.value = result.fileId;
  } catch (error) {
    openError.value = error instanceof Error ? error.message : String(error);
  }
});

// Best-effort explicit close — the channel-detach path covers crashes.
window.addEventListener("pagehide", () => {
  if (fileId.value) void session.call("close", fileId.value);
});

const file = computed(() =>
  fileId.value ? (session.state.files[fileId.value] ?? null) : null,
);
// Mutable playback state rides telemetry (C-14 reshape): the static `file`
// entry no longer carries `positionNs`/`playing`. Null = closed / not yet
// pushed → treat as not playing, position 0.
const playback = computed(() =>
  fileId.value ? (session.telemetry.position[fileId.value] ?? null) : null,
);
const playing = computed(() => playback.value?.playing ?? false);
const basename = computed(() => props.path.split("/").pop() ?? props.path);

// --- tracks ---------------------------------------------------------------

// The §2b telemetry channel is JSON (per-frame extras), not pixels — listed
// as a track but not selectable for display.
const isVisual = (c: ViewerChannel) => c.name !== "telemetry";
const selected = ref<string | null>(null);
const selectedChannel = computed(() => {
  const channels = file.value?.channels ?? [];
  if (selected.value && channels.some((c) => c.name === selected.value && isVisual(c)))
    return selected.value;
  return channels.find(isVisual)?.name ?? null;
});

const payload = computed(() =>
  fileId.value && selectedChannel.value
    ? session.frame(`${fileId.value}:${selectedChannel.value}`).payload.value
    : null,
);

// --- descriptor overlay (multi-fovea recordings, wave I-2 ruling 6) --------
// `fovea/<target>` tracks carry `{tNs, bbox, frames}` observation docs whose
// bbox is in WIDE (center-stream) coordinates. The session replays them
// latest-wins (nearest-sample at playback rate; scrub redraw repopulates the
// latest-before doc), so the overlay just draws the current doc per target
// whenever the wide stream is the one displayed.
const TARGET_COLORS = [
  "#00aaff", "#ffb000", "#36d16f", "#ff5b8a",
  "#b983ff", "#00d5c7", "#ff7a35", "#d6e04f",
];
type OverlayBox = { topic: string; index: number; bbox: { x: number; y: number; width: number; height: number } };
const overlayBoxes = computed<OverlayBox[]>(() => {
  if (!fileId.value || selectedChannel.value !== "center") return [];
  const docs = session.telemetry.descriptors[fileId.value];
  if (!docs) return [];
  const out: OverlayBox[] = [];
  for (const [topic, doc] of Object.entries(docs)) {
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
  if (!fileId.value || !file.value) return;
  if (playing.value) void session.call("pause", fileId.value);
  else void session.call("play", { fileId: fileId.value, rate: rate.value });
}

function setRate(event: Event): void {
  rate.value = Number((event.target as HTMLSelectElement).value);
  // Re-issue play at the new rate if currently playing.
  if (fileId.value && playing.value)
    void session.call("play", { fileId: fileId.value, rate: rate.value });
}

// Scrub: while dragging, the slider shows the local value (the session's
// `positionNs` echo would fight the thumb); seeks are sent live while
// dragging (commands are cheap) and the local override lifts on release.
const scrubbing = ref(false);
const scrubNs = ref(0);
const positionNs = computed(() =>
  scrubbing.value ? scrubNs.value : (playback.value?.positionNs ?? 0),
);

function onScrub(event: Event): void {
  const tNs = Number((event.target as HTMLInputElement).value);
  scrubbing.value = true;
  scrubNs.value = tNs;
  if (fileId.value) void session.call("seek", { fileId: fileId.value, tNs });
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
          <StreamView v-if="payload" :payload="payload" width="100%" height="100%">
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
          </StreamView>
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
  <TitleBar title="Viewer" :subtitle="basename" @height="(h) => (titleBarHeight = h)" />
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
