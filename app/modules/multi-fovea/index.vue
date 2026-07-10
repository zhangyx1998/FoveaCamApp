<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useConfigRef } from "@lib/config";
import { useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { pipes } from "@lib/orchestrator/pipe-contract";
import { multiFovea, MAX_MULTI_FOVEA_TARGETS, PRESET_ANGLE_LIMIT_DEG } from "./contract";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import Drawer from "@src/components/Drawer.vue";
import Recording from "@src/record";
import Capture from "@src/capture";
import type { Point2d, Rect, Size } from "core/Geometry";

const session = useSession(multiFovea, "multi-fovea");
const { state, telemetry } = session;
// Recording context (multi-fovea-recording ruling 7): registers this window's
// title-bar RecordButton (AppWindow) + its Cmd/Ctrl-R `onRecorderTrigger`
// consumer against the session's startRecording/stopRecording — the exact
// manual-control facade, reused not forked. Per-window singleton (each app
// window is its own renderer), so no double-registration across apps; the
// RecordButton's onBeforeUnmount disposer drops the trigger hook with the
// window.
new Recording(session, "multi-fovea");
// Capture context (capture-recorder-everywhere ruling 3): lights this window's
// camera icon (AppWindow) → the shared CapturePreview window (its in-window
// button drives the shot). Per-window singleton, disposed on unmount.
new Capture(session, "multi-fovea");
const pipesSession = useSession(pipes, "pipes");
// real-1g (C-23): the wide view binds the first-class UNDISTORTED pipe when the
// session advertises it (target overlays are in undistorted pixel space); falls
// back to raw on uncalibrated rigs. Per-fovea processed crops bind their node
// pipes via `usePipeFrame` too (see `foveaFrames` below — the old
// `session.frame("fovea:<i>")` producers are gone).
const center = usePipeFrame(() =>
  state.undistortPipe ?? (state.serials?.C ? nodeId.convert(state.serials.C) : null),
);
const selectedTarget = ref(0);
const draftCenter = ref<Point2d | null>(null);
// Bottom Drawer height (manual-control idiom) — its live height is reserved as
// bottom padding on the scroll root (`--p`) so content is never hidden behind
// the fixed drawer. Holds the settle slider + preset-location editors.
const drawer_height = ref(0);

// Per-stream RECORDING compression switches (multi-fovea-recording ruling 9).
// They ENABLE the app-level `record_compression` method per stream: the label
// follows the CONFIGURED method (read reactively from the shared config doc),
// and under "none" the switches are DISABLED (nothing compresses; the server
// gate holds too). Writing a nested state key needs a WHOLE-object reassign to
// trip the reactive push (customRef fires on the top-level key only).
const record_compression = await useConfigRef("record_compression");
const compressionOn = computed(() => record_compression.value === "zlib");
const COMPRESS_STREAMS = ["left", "center", "right"] as const;
function toggleCompress(stream: (typeof COMPRESS_STREAMS)[number], on: boolean): void {
  state.record_compress = { ...state.record_compress, [stream]: on };
}
const stroke = computed(
  () => Math.max(telemetry.size.width, telemetry.size.height, 1) * 0.003,
);

// Trigger SETTLE hold. State is µs (protocol units); the slider edits ms with
// sub-ms resolution (0–20 ms). Seeded server-side from the active triple at
// activation; this override is LIVE for the running session (every CMD_FRAME
// picks up the current value). See docs/proposals/trigger-settle-time.md.
const settleMs = computed({
  get: () => state.settle_time_us / 1000,
  set: (ms: number) => {
    state.settle_time_us = Math.max(0, Math.round(ms * 1000));
  },
});

// Angle-space DEMO presets (mirror degrees). Editing pan/tilt re-parks the
// mirror for that slot LIVE via `placePreset`; the round-robin keeps
// interleaving. Only preset-bearing targets show here (the demo's two).
function setPresetPan(index: number, pan: number): void {
  const t = state.targets[index];
  if (!t?.preset) return;
  session.call("placePreset", { index, pan, tilt: t.preset.tilt });
}
function setPresetTilt(index: number, tilt: number): void {
  const t = state.targets[index];
  if (!t?.preset) return;
  session.call("placePreset", { index, pan: t.preset.pan, tilt });
}

const TARGET_COLORS = [
  "#00aaff",
  "#ffb000",
  "#36d16f",
  "#ff5b8a",
  "#b983ff",
  "#00d5c7",
  "#ff7a35",
  "#d6e04f",
];

let dragging = false;
let lastSteer: Point2d = { x: 0, y: 0 };

function setTargetEnabled(index: number, enabled: boolean): void {
  selectedTarget.value = index;
  session.call("setTargetEnabled", { index, enabled });
}

function onTargetEnabled(index: number, event: Event): void {
  setTargetEnabled(index, (event.target as HTMLInputElement).checked);
}

function onSelectedTarget(index: number): void {
  selectedTarget.value = index;
}

function targetColor(index: number): string {
  return TARGET_COLORS[index % TARGET_COLORS.length];
}

function targetCenter(index: number, bbox: Rect | null | undefined): Point2d {
  if (bbox)
    return {
      x: bbox.x + bbox.width / 2,
      y: bbox.y + bbox.height / 2,
    };
  return state.targets[index]?.center ?? { x: 0, y: 0 };
}

function onCursor(c: (Point2d & Size & { buttons: number }) | null): void {
  if (c) {
    lastSteer = { x: c.x, y: c.y };
    if (c.buttons & 1) {
      dragging = true;
      draftCenter.value = lastSteer;
      session.call("steerTarget", {
        index: selectedTarget.value,
        center: lastSteer,
      });
    } else if (dragging) {
      dragging = false;
      session.call("placeTarget", {
        index: selectedTarget.value,
        center: lastSteer,
      });
      draftCenter.value = null;
    }
  } else if (dragging) {
    dragging = false;
    session.call("placeTarget", {
      index: selectedTarget.value,
      center: lastSteer,
    });
    draftCenter.value = null;
  }
}

// C-24 step 4: THE RENDERER COMPOSES the per-target fovea crop nodes (the
// composition directive's flagship). Each enabled target demands its
// camera-rooted `camera/<serial>/undistort/fovea/<slot>` brick via `compose`
// (refcounted — another window composing the same slot shares one brick;
// window close auto-unrefs server-side); disabling decomposes. The preview
// binds the node's pipe via `usePipeFrame` — these tiles get REAL pixels for
// the first time (the old `session.frame("fovea:<i>")` had no producer). The
// SESSION steers the crop rect per tracker tick; v4 frame-bound origin keeps
// overlays exact.
const composed = new Set<string>();

function foveaParams(index: number) {
  const t = state.targets[index];
  const size = {
    width: t?.tracker.width ?? 128,
    height: t?.tracker.height ?? 128,
  };
  const center = t?.center ?? { x: 0, y: 0 };
  return {
    rect: {
      x: Math.max(0, Math.round(center.x - size.width / 2)),
      y: Math.max(0, Math.round(center.y - size.height / 2)),
      width: size.width,
      height: size.height,
    },
    maxWidth: 512,
    maxHeight: 512,
  };
}

function syncComposition(): void {
  const serial = state.serials?.C;
  const want = new Set<string>();
  if (serial)
    for (let i = 0; i < MAX_MULTI_FOVEA_TARGETS; i++)
      if (state.targets[i]?.enabled) want.add(nodeId.fovea(serial, i));
  for (const id of composed)
    if (!want.has(id)) {
      composed.delete(id);
      void pipesSession.call("decompose", { id }).catch(() => {});
    }
  for (const id of want)
    if (!composed.has(id)) {
      composed.add(id);
      const index = Number(id.split("/").pop());
      void pipesSession
        .call("compose", { id, kind: "fovea", inputs: {}, params: foveaParams(index) })
        .catch((e) => {
          composed.delete(id); // e.g. camera not leased yet — the watch retries
          console.warn(`[multi-fovea] compose ${id}:`, e);
        });
    }
}

watch(
  () => [state.serials?.C, ...state.targets.map((t) => t.enabled)],
  syncComposition,
  { immediate: true },
);
onUnmounted(() => {
  for (const id of composed) void pipesSession.call("decompose", { id }).catch(() => {});
  composed.clear();
});

// One static hook per slot (composables can't be created in loops at runtime);
// binds as soon as the composed node's pipe is advertised.
const foveaFrames = Array.from({ length: MAX_MULTI_FOVEA_TARGETS }, (_, i) =>
  usePipeFrame(() =>
    state.serials?.C && state.targets[i]?.enabled
      ? nodeId.fovea(state.serials.C, i)
      : null,
  ),
);

async function captureOnce(): Promise<void> {
  const result = await session.call("captureOnce", undefined);
  if (!result.ok) console.warn(`[multi-fovea] capture rejected: ${result.reason}`);
}
</script>

<template>
  <div
    class="multi-fovea"
    :style="{ '--p': (drawer_height ? drawer_height + 20 : 0) + 'px' }"
  >
    <section class="overview">
      <StreamView
        class="center"
        title="Center Overview"
        :payload="center"
        theme="#0af"
        inspector
        @mouse="onCursor"
      >
        <g
          v-for="target in telemetry.targets"
          :key="target.index"
          :class="{ selected: target.index === selectedTarget }"
        >
          <template v-if="target.enabled">
            <rect
              v-if="target.bbox"
              :x="target.bbox.x"
              :y="target.bbox.y"
              :width="target.bbox.width"
              :height="target.bbox.height"
              :stroke="targetColor(target.index)"
              :stroke-width="target.index === selectedTarget ? stroke * 1.8 : stroke"
              fill="none"
            />
            <circle
              :cx="targetCenter(target.index, target.bbox).x"
              :cy="targetCenter(target.index, target.bbox).y"
              :r="stroke * 3"
              :fill="targetColor(target.index)"
            />
            <text
              :x="targetCenter(target.index, target.bbox).x + stroke * 5"
              :y="targetCenter(target.index, target.bbox).y - stroke * 5"
              :fill="targetColor(target.index)"
              :font-size="stroke * 9"
              font-weight="700"
              paint-order="stroke"
              stroke="#000"
              :stroke-width="stroke * 2"
            >
              {{ target.index + 1 }}
            </text>
          </template>
        </g>
        <circle
          v-if="draftCenter"
          :cx="draftCenter.x"
          :cy="draftCenter.y"
          :r="stroke * 5"
          :stroke="targetColor(selectedTarget)"
          :stroke-width="stroke"
          fill="none"
        />
      </StreamView>
      <div class="controls">
        <div class="status">
          <span :class="{ live: telemetry.ready }">ready</span>
          <span :class="{ live: telemetry.v2Capable }">v2</span>
          <span>{{ telemetry.captureRejected }}</span>
        </div>
        <!-- Fail-closed explanation (UI/UX review 2026-07-10): on major-1
             firmware the round-robin stream path returns null and the demo
             would otherwise be a silent blank interleave. -->
        <p v-if="!telemetry.v2Capable" class="fw-hint">
          Requires v2.0 firmware — reflash the MCU to run the interleaved
          demo (streams are disabled on this firmware).
        </p>
        <label>
          Pulse
          <RangeSlider v-model="state.pulse_ns" :min="100000" :max="10000000" :step="100000" />
        </label>
        <button @click="captureOnce">Capture</button>
        <button @click="session.call('resetTargets', undefined)">Reset</button>

        <div class="record-compress" :class="{ off: !compressionOn }">
          <span class="rc-title">
            Record compression
            <span v-if="compressionOn" class="rc-method">{{ record_compression }}</span>
          </span>
          <div class="rc-streams">
            <label
              v-for="s in COMPRESS_STREAMS"
              :key="s"
              class="rc-toggle"
              :title="
                compressionOn ? undefined : 'Compression is off — enable it in Settings (⌘,)'
              "
            >
              <input
                type="checkbox"
                :checked="state.record_compress[s]"
                :disabled="!compressionOn"
                @change="toggleCompress(s, ($event.target as HTMLInputElement).checked)"
              />
              {{ s }}
            </label>
          </div>
          <p class="rc-hint">
            {{ compressionOn ? "" : "compression off — enable in Settings (⌘,)" }}
          </p>
        </div>
      </div>
    </section>

    <section class="targets">
      <article v-for="(target, index) in state.targets" :key="index" class="target">
        <header>
          <label>
            <input
              type="radio"
              name="multi-fovea-target"
              :checked="selectedTarget === index"
              @change="onSelectedTarget(index)"
            />
            <input
              type="checkbox"
              :checked="target.enabled"
              @change="onTargetEnabled(index, $event)"
            />
            Target {{ index + 1 }}
          </label>
          <span>stream {{ telemetry.targets[index]?.streamId ?? "-" }}</span>
        </header>
        <div class="target-body">
          <StreamView
            title="Fovea"
            :payload="foveaFrames[index]?.value ?? null"
            theme="#fa0"
            height="14rem"
          />
          <PosView
            :pos="telemetry.targets[index]?.volt.L ?? { x: 0, y: 0 }"
            color="#0af"
            style="width: 100%"
          />
        </div>
        <footer>
          <span>lost {{ telemetry.targets[index]?.lostCount ?? 0 }}</span>
          <span>{{ (telemetry.targets[index]?.streamHz ?? 0).toFixed(1) }} Hz</span>
          <span>{{ telemetry.targets[index]?.lastFinAgeMs?.toFixed(0) ?? "-" }} ms</span>
        </footer>
      </article>
    </section>
  </div>

  <Drawer v-model="drawer_height">
    <div class="drawer-body">
      <section class="drawer-section">
        <label class="settle">
          <span>Settle {{ settleMs.toFixed(1) }} ms</span>
          <RangeSlider v-model="settleMs" :min="0" :max="20" :step="0.1" />
        </label>
        <p class="drawer-hint">
          Trigger hold after a stream switch (mirror moved). Seeded from the
          triple; overrides live. 0 = no hold.
        </p>
      </section>

      <section class="drawer-section">
        <span class="drawer-title">Preset locations (mirror °)</span>
        <template v-for="(target, index) in state.targets" :key="index">
          <div v-if="target.preset" class="preset-row">
            <span class="preset-label" :style="{ color: targetColor(index) }">
              {{ index + 1 }}
            </span>
            <label>
              pan
              <input
                type="number"
                step="0.5"
                :min="-PRESET_ANGLE_LIMIT_DEG"
                :max="PRESET_ANGLE_LIMIT_DEG"
                :value="target.preset.pan"
                @change="setPresetPan(index, Number(($event.target as HTMLInputElement).value))"
              />
            </label>
            <label>
              tilt
              <input
                type="number"
                step="0.5"
                :min="-PRESET_ANGLE_LIMIT_DEG"
                :max="PRESET_ANGLE_LIMIT_DEG"
                :value="target.preset.tilt"
                @change="setPresetTilt(index, Number(($event.target as HTMLInputElement).value))"
              />
            </label>
          </div>
        </template>
      </section>
    </div>
  </Drawer>
</template>

<style scoped lang="scss">
.multi-fovea {
  display: grid;
  grid-template-rows: minmax(20rem, 1fr) auto;
  gap: 1rem;
  /* Reserve the fixed Drawer's live height at the bottom (manual-control idiom)
     so the targets grid is never obscured behind it. */
  --p: 0;
  padding: 1rem 1rem calc(1rem + var(--p)) 1rem;
  min-height: 100%;
  box-sizing: border-box;
  background: var(--bg-panel-alt);
  color: var(--text-strong);
}

.overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 18rem;
  gap: 1rem;
  min-height: 0;
}

.center {
  min-height: 18rem;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.status {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;

  span {
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    background: var(--border);
    color: var(--text-muted);

    &.live {
      background: #064;
      color: var(--text);
    }
  }
}

.fw-hint {
  margin: 0.4rem 0 0;
  padding: 0.3rem 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--warn);
  color: var(--warn);
  font-size: 0.85em;
}

button {
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  background: var(--bg-elevated);
  color: inherit;
  padding: 0.45rem 0.65rem;
  cursor: pointer;
}

.drawer-body {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  padding: 1rem 1.25rem;
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
  color: var(--text-strong);
}

.drawer-section {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 16rem;

  .drawer-title {
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .settle {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.9rem;
  }
  .drawer-hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-faint);
  }
  .preset-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .preset-label {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 4px;
    background: var(--border);
    font-weight: 700;
    flex: none;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.35ch;
    color: var(--text-muted);
  }
  input[type="number"] {
    width: 4rem;
    padding: 0.2rem 0.3rem;
    border: 1px solid var(--border-muted);
    border-radius: 4px;
    background: var(--bg-elevated);
    color: inherit;
  }
}

.record-compress {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);

  &.off {
    color: var(--text-muted);
  }

  .rc-title {
    display: flex;
    align-items: center;
    gap: 0.5ch;
    /* Reserve the badge's height so it appearing/disappearing never nudges the
       checkbox row below (layout-stable across the live Settings toggle). */
    min-height: 1.25rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .rc-method {
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
    background: var(--accent);
    color: var(--text);
    font-size: 0.75rem;
  }
  .rc-streams {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .rc-toggle {
    display: flex;
    align-items: center;
    gap: 0.35ch;
    font-size: 0.85rem;
  }
  .rc-hint {
    margin: 0;
    /* Always rendered (text swaps to empty when compression is on) so the block
       height is identical in both states — no reflow of the controls panel. */
    min-height: 1rem;
    font-size: 0.75rem;
    color: var(--text-faint);
  }
}

.targets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 1rem;
}

.target {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;

  header,
  footer {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
}

.target-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 5rem;
  gap: 0.5rem;
  align-items: center;
}
</style>
