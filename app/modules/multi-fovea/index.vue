<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { pipes } from "@lib/orchestrator/pipe-contract";
import { multiFovea, MAX_MULTI_FOVEA_TARGETS } from "./contract";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import type { Point2d, Rect, Size } from "core/Geometry";

const session = useSession(multiFovea, "multi-fovea");
const { state, telemetry } = session;
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
const stroke = computed(
  () => Math.max(telemetry.size.width, telemetry.size.height, 1) * 0.003,
);

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
  <div class="multi-fovea">
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
        <label>
          Pulse
          <RangeSlider v-model="state.pulse_ns" :min="100000" :max="10000000" :step="100000" />
        </label>
        <button @click="captureOnce">Capture</button>
        <button @click="session.call('resetTargets', undefined)">Reset</button>
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
</template>

<style scoped lang="scss">
.multi-fovea {
  display: grid;
  grid-template-rows: minmax(20rem, 1fr) auto;
  gap: 1rem;
  padding: 1rem;
  min-height: 100%;
  box-sizing: border-box;
  background: #161616;
  color: #ddd;
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
  background: #202020;
  border: 1px solid #333;
  border-radius: 6px;
}

.status {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;

  span {
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    background: #333;
    color: #aaa;

    &.live {
      background: #064;
      color: white;
    }
  }
}

button {
  border: 1px solid #555;
  border-radius: 4px;
  background: #292929;
  color: inherit;
  padding: 0.45rem 0.65rem;
  cursor: pointer;
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
  background: #202020;
  border: 1px solid #333;
  border-radius: 6px;

  header,
  footer {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    color: #aaa;
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
