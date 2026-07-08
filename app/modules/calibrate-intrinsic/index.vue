<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Per-camera intrinsic calibration, migrated to the orchestrator (docs/
  refactor/orchestrator.md §7.1 S1b). Thin client over the
  `calibrate-intrinsic` session: the orchestrator enumerates cameras, leases
  the one selected for live detection (checkerboard or ArUco/AprilTag
  marker), and runs the actual `calibrateCamera` solve. Checker and marker
  sub-views are unified into one component here since the server-side state
  machine is unified too (`state.method` switches which detector runs).
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { calibrateIntrinsic } from "./contract";
import StreamView from "@src/components/StreamView.vue";
import NavBack from "@src/components/NavBack.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import CameraRole from "@src/components/CameraRole.vue";
import Badge from "@src/components/Badge.vue";
import { DictionaryTypeSelector } from "./dictionary-selector";
import type { PreDefinedDictionary } from "core/Vision";

const session = useSession(calibrateIntrinsic, "calibrate-intrinsic");
const { state, telemetry } = session;
// real-1c: raw preview off the active camera's native pipe (marker-detection
// overlay still rides telemetry).
const preview = usePipeFrame(() =>
  state.activeSerial ? nodeId.convert(state.activeSerial) : null,
);

const views = computed(() => Object.values(telemetry.views));
const activeView = computed(() =>
  state.activeSerial ? telemetry.views[state.activeSerial] : null,
);

onMounted(() => session.call("refresh", undefined));
onUnmounted(() => {
  if (state.activeSerial) session.call("deselect", undefined);
});

function degrees(rad: number): string {
  return ((rad * 180) / Math.PI).toFixed(2);
}

function stroke(): number {
  return Math.max(telemetry.size.width, telemetry.size.height, 1) * 0.006;
}

// `state.pattern_size` is a single customRef holding a plain object —
// mutating `state.pattern_size.width` in place would neither reach the
// server nor re-render locally (same pitfall as disparity-scope's `tuning`).
const pattern_w = computed<number>({
  get: () => state.pattern_size.width,
  set: (v) => (state.pattern_size = { ...state.pattern_size, width: v }),
});
const pattern_h = computed<number>({
  get: () => state.pattern_size.height,
  set: (v) => (state.pattern_size = { ...state.pattern_size, height: v }),
});
</script>

<template>
  <div v-if="!state.activeSerial" class="items">
    <h1 style="margin: 0; padding: 0">Select a camera to calibrate</h1>
    <template v-for="v in views" :key="v.info.serial">
      <div class="divider"></div>
      <div class="list-item">
        <div class="info">
          <h3 style="margin: 0; padding: 0">
            <span style="font-weight: bold; margin-right: 1.5ch">{{ v.info.vendor }}</span>
            <span style="font-weight: normal; font-style: italic">{{ v.info.model }}</span>
          </h3>
          <div style="display: flex; gap: 1em; margin: 1em 0">
            <Badge color="#aaa">Serial {{ v.info.serial }}</Badge>
            <CameraRole v-if="v.role" :role="(v.role as any)" />
          </div>
          <template v-if="v.fov">
            <ConfigEntry style="color: white">
              Calibrated @ {{ v.calibrated_at ? new Date(v.calibrated_at).toLocaleString() : "N/A" }}
            </ConfigEntry>
            <ConfigEntry style="color: white">
              FOV: X {{ degrees(v.fov.x) }}&deg;, Y {{ degrees(v.fov.y) }}&deg;
            </ConfigEntry>
          </template>
          <template v-else>
            <ConfigEntry style="color: gray">Camera not calibrated.</ConfigEntry>
          </template>
        </div>
        <div class="actions">
          <button
            style="--theme: #06a"
            @click="((state.method = 'CHECKER'), session.call('select', { serial: v.info.serial }))"
          >
            Calibrate (Checker)
          </button>
          <button
            style="--theme: #084"
            @click="((state.method = 'MARKER'), session.call('select', { serial: v.info.serial }))"
          >
            Calibrate (Marker)
          </button>
          <button
            :disabled="!v.fov"
            style="--theme: #a00"
            @click="session.call('resetCalibration', { serial: v.info.serial })"
          >
            Reset
          </button>
        </div>
      </div>
    </template>
  </div>

  <div v-else class="view">
    <div class="left" style="flex-grow: 1; padding-top: 3em">
      <NavBack @back="session.call('deselect', undefined)">
        <span>{{ activeView?.info.vendor }} {{ activeView?.info.model }}</span>
        <CameraRole v-if="activeView?.role" :role="(activeView.role as any)" />
      </NavBack>
      <StreamView class="stream" :payload="preview" height="min(60vh, 80vw)">
        <circle
          v-for="(p, i) in telemetry.detection?.points ?? []"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          :r="stroke()"
          fill="#0f0"
          stroke="white"
          :stroke-width="stroke() * 0.3"
        />
      </StreamView>
      <ConfigEntry v-if="state.method === 'CHECKER'">
        Pattern Size: W
        <input v-model.number="pattern_w" style="width: 2ch" />
        &times; H
        <input v-model.number="pattern_h" style="width: 2ch" />
        -&gt; {{ telemetry.detection?.points.length ?? 0 }} corners
      </ConfigEntry>
      <ConfigEntry v-else>
        <label>
          Marker Dictionary
          <DictionaryTypeSelector
            :model-value="state.dictionary as PreDefinedDictionary"
            @update:model-value="(v: PreDefinedDictionary) => (state.dictionary = v)"
          />
        </label>
      </ConfigEntry>
      <ConfigEntry v-if="activeView?.calibrated_at">
        Calibrated At&nbsp;<span>{{ new Date(activeView.calibrated_at).toLocaleString() }}</span>
      </ConfigEntry>
      <ConfigEntry v-if="activeView?.fov">
        FOV: X {{ degrees(activeView.fov.x) }}&deg;, Y {{ degrees(activeView.fov.y) }}&deg;
      </ConfigEntry>
    </div>
    <div class="right">
      <h2>Captured Records ({{ telemetry.recordCount }})</h2>
      <div class="records">
        <div v-for="i in telemetry.recordCount" :key="i" class="record-chip" @click="session.call('removeRecord', { index: i - 1 })">
          #{{ i }}
        </div>
      </div>
      <div class="buttons">
        <button @click="session.call('capture', undefined)" :disabled="!telemetry.detection">Capture</button>
        <button @click="session.call('calibrateNow', undefined)" :disabled="!telemetry.recordCount || telemetry.busy">
          {{ telemetry.busy ? "Calibrating…" : "Calibrate" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.items {
  position: absolute;
  top: 0;
  left: 50%;
  max-height: 100%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-content: flex-start;
  align-items: stretch;
  flex-wrap: nowrap;
  overflow-y: scroll;
  gap: 1em;
  padding: 2em;
}
.divider {
  height: 1px;
  background-color: #333;
  margin: 1em 0;
}
.list-item {
  height: 100%;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 2em;
  padding: 1.5em;
  outline: 1px solid #666;
  border-radius: 1em;
  &:hover {
    outline-color: #08c;
    background-color: #fff1;
  }
}
.info {
  flex-grow: 1;
}
.actions {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: stretch;
  gap: 0.5em;
  button {
    --theme: #08c;
    display: block;
    padding: 0.5em 1em;
    border-radius: 0.5em;
    &:not(:disabled) {
      cursor: pointer;
      background-color: var(--theme);
      color: white;
      border: 1px solid transparent;
      &:hover {
        filter: brightness(1.2);
      }
    }
    &:disabled {
      background-color: transparent;
      color: #666;
      border: 1px solid #666;
      cursor: not-allowed;
    }
  }
}

.view {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: row;
  .left,
  .right {
    display: flex;
    flex-direction: column;
  }
  .left {
    justify-content: center;
    align-items: center;
    background-color: #111;
  }
  .right {
    border-left: 2px solid #333;
    background-color: #222;
    width: max(30vw, 20ch);
    box-sizing: border-box;
    padding: 1rem;
    h2 {
      margin: 0 0 1rem;
      font-size: 1.4rem;
    }
    .records {
      flex-grow: 1;
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-content: flex-start;
      overflow-y: auto;
    }
    .record-chip {
      padding: 0.4em 0.8em;
      border-radius: 0.4em;
      background: #fff2;
      cursor: pointer;
      &:hover {
        background: #fff4;
      }
    }
    .buttons {
      display: flex;
      flex-direction: row;
      gap: 1rem;
      margin-top: 1rem;
      & > * {
        display: block;
        width: 0;
        flex-grow: 1;
        height: 2rem;
      }
    }
  }
}
</style>
