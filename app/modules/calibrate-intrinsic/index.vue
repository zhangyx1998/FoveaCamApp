<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Per-camera intrinsic calibration — a thin client over the `calibrate-intrinsic`
  session (checker + marker unified, `state.method` switches the detector).
  Behavior spec: docs/spec/calibrate-intrinsic.md.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { calibrateIntrinsic, MIN_SOLVE_SAMPLES, type RecordThumb } from "./contract";
import Recording from "@src/record";
import Capture from "@src/capture";
import StreamView from "@src/components/StreamView.vue";
import FrameView from "@src/components/FrameView.vue";
import NavBack from "@src/components/NavBack.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import CameraRole from "@src/components/CameraRole.vue";
import Badge from "@src/components/Badge.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";
import { makeMat } from "@lib/mat";
import { DictionaryTypeSelector } from "./dictionary-selector";
import type { PreDefinedDictionary } from "core/Vision";

const session = useSession(calibrateIntrinsic, "calibrate-intrinsic");
// Serial whose Reset is awaiting the two-step confirm (null = none).
const confirmingReset = ref<string | null>(null);
const { state, telemetry } = session;
// Recording context (capture-recorder-everywhere ruling 2): the title-bar
// RecordButton + Cmd/Ctrl-R record the selected camera's raw sensor stream.
new Recording(session, "calibrate-intrinsic");
// Capture facade — camera-icon toggle of the shared preview window.
new Capture(session, "calibrate-intrinsic");

// Wrap a record's downscaled Mono8 preview in a Mat for FrameView.
function thumbMat(t: RecordThumb) {
  return makeMat(t.data, [t.height, t.width], 1);
}

// CHECKER projection: the physical square size is renderer-local — it scales the
// projected board only, never the corner-count math the session solves on.
const pattern_size_mm = ref(10.0);
const pattern = computed(() => {
  const mm = pattern_size_mm.value;
  const { width, height } = state.pattern_size;
  const blacks: Array<{ x: number; y: number; width: string; height: string }> = [];
  const x0 = (width + 1) * mm * -0.5;
  const y0 = (height + 1) * mm * -0.5;
  for (let y = 0; y <= height; y++)
    for (let x = 0; x <= width; x++)
      if ((x + y) % 2 === 0)
        blacks.push({ x: x0 + x * mm, y: y0 + y * mm, width: mm + "px", height: mm + "px" });
  return blacks;
});
// Raw preview off the active camera's native pipe (overlay rides telemetry).
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

// Whole-object replace — `state.pattern_size` is a single customRef, so a nested
// `.width = v` reaches neither server nor render.
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
    <div class="picker-head">
      <h1 style="margin: 0; padding: 0">Select a camera to calibrate</h1>
      <!-- Re-enumerate on demand (review #16): the list was populated once on
           mount — a camera plugged in afterwards never appeared. -->
      <button class="refresh" title="Re-scan connected cameras" @click="session.call('refresh', undefined)">
        Refresh
      </button>
    </div>
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
            <ConfigEntry style="color: var(--text)">
              Calibrated @ {{ v.calibrated_at ? new Date(v.calibrated_at).toLocaleString() : "N/A" }}
            </ConfigEntry>
            <ConfigEntry style="color: var(--text)">
              FOV: X {{ degrees(v.fov.x) }}&deg;, Y {{ degrees(v.fov.y) }}&deg;
            </ConfigEntry>
            <ConfigEntry v-if="v.rms != null" style="color: var(--text)">
              RMS: {{ v.rms.toFixed(3) }} px
            </ConfigEntry>
          </template>
          <template v-else>
            <ConfigEntry style="color: var(--text-faint)">Camera not calibrated.</ConfigEntry>
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
          <!-- Two-step confirm (UI/UX review 2026-07-11): reset drops this
               camera's association and HARD-DELETES an orphaned record — more
               destructive than the Settings Discard (which trashes), so it
               must not fire on one click, and the copy must say "permanently". -->
          <!-- Enabled whenever ANY stored calibration exists — including a
               CORRUPT record (calibrated_at set, fov null because the Undistort
               rebuild failed), which is exactly the record one most needs to
               reset (review #16). -->
          <button
            v-if="confirmingReset !== v.info.serial"
            :disabled="!v.fov && !v.calibrated_at"
            style="--theme: var(--danger)"
            @click="confirmingReset = v.info.serial"
          >
            Reset
          </button>
          <template v-else>
            <span class="reset-warn">
              Permanently deletes this camera's calibration (cannot be undone;
              records shared with other cameras keep their other bindings).
            </span>
            <button
              style="--theme: var(--danger)"
              @click="
                ((confirmingReset = null),
                session.call('resetCalibration', { serial: v.info.serial }))
              "
            >
              Delete
            </button>
            <button @click="confirmingReset = null">Cancel</button>
          </template>
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
      <StreamView
        class="stream"
        :payload="preview"
        height="min(60vh, 80vw)"
        :footnote="`Detector @ ${telemetry.detectRate.toFixed(1)} Hz`"
      >
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
      <template v-if="state.method === 'CHECKER'">
        <ConfigEntry>
          Pattern Size: W
          <input v-model.number="pattern_w" style="width: 2ch" />
          &times; H
          <input v-model.number="pattern_h" style="width: 2ch" />
          -&gt; {{ telemetry.detection?.points.length ?? 0 }} corners
        </ConfigEntry>
        <RangeSlider v-model.number="pattern_size_mm" :min="1" :max="50" :step="1" style="max-width: 40ch">
          <span>Pattern Size (mm)</span>
          <span>{{ pattern_size_mm.toFixed(2) }} mm</span>
        </RangeSlider>
      </template>
      <template v-else>
        <ConfigEntry>
          <label>
            Marker Dictionary
            <DictionaryTypeSelector
              :model-value="state.dictionary as PreDefinedDictionary"
              @update:model-value="(v: PreDefinedDictionary) => (state.dictionary = v)"
            />
          </label>
        </ConfigEntry>
        <RangeSlider v-model.number="state.scale" :min="1" :max="8" :step="1" style="max-width: 40ch">
          <span>Detector Downscale</span>
          <span>1 / {{ state.scale }}</span>
        </RangeSlider>
      </template>
      <ConfigEntry v-if="activeView?.calibrated_at">
        Calibrated At&nbsp;<span>{{ new Date(activeView.calibrated_at).toLocaleString() }}</span>
      </ConfigEntry>
      <ConfigEntry v-if="activeView?.fov">
        FOV: X {{ degrees(activeView.fov.x) }}&deg;, Y {{ degrees(activeView.fov.y) }}&deg;
      </ConfigEntry>
      <ConfigEntry v-if="telemetry.lastRms != null">
        Last Solve RMS&nbsp;<span>{{ telemetry.lastRms.toFixed(3) }} px</span>
      </ConfigEntry>
    </div>
    <div class="right">
      <h2>Captured Records ({{ telemetry.recordCount }})</h2>
      <div class="records">
        <div
          v-for="rec in telemetry.records"
          :key="rec.id"
          class="record-chip"
          title="Click to remove"
          @click="session.call('removeRecord', { id: rec.id })"
        >
          <FrameView :mat="thumbMat(rec)" width="100%" />
        </div>
      </div>
      <div class="buttons">
        <button @click="session.call('capture', undefined)" :disabled="!telemetry.detection">Capture</button>
        <!-- Gated on the shared minimum-sample floor (review #13): a 1–2 view
             solve persists plausible garbage. The tooltip names the shortfall. -->
        <button
          @click="session.call('calibrateNow', undefined)"
          :disabled="telemetry.sampleCount < MIN_SOLVE_SAMPLES || telemetry.busy"
          :title="
            telemetry.sampleCount < MIN_SOLVE_SAMPLES
              ? `Need ${MIN_SOLVE_SAMPLES} samples (${telemetry.sampleCount} captured)`
              : 'Solve and persist the intrinsic calibration'
          "
        >
          {{
            telemetry.busy
              ? "Calibrating…"
              : telemetry.sampleCount < MIN_SOLVE_SAMPLES
                ? `Calibrate (${telemetry.sampleCount}/${MIN_SOLVE_SAMPLES})`
                : "Calibrate"
          }}
        </button>
      </div>
    </div>
    <!-- CHECKER projection (item 2): white field + black squares projected onto
         the remote display so the operator has a physical board to calibrate. -->
    <RemoteCanvasTeleport v-if="state.method === 'CHECKER'">
      <rect x="-50vw" y="-50vh" width="100vw" height="100vh" fill="white" />
      <rect v-for="(p, i) in pattern" :key="i" v-bind="p" fill="black" />
    </RemoteCanvasTeleport>
  </div>
</template>

<style scoped lang="scss">
.picker-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 2ch;

  .refresh {
    padding: 0.4em 1em;
    border-radius: 0.5em;
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--border-muted);
    cursor: pointer;
    &:hover {
      color: var(--text);
      border-color: var(--accent);
      background: var(--tint-1);
    }
  }
}

.reset-warn {
  color: var(--danger-text);
  font-size: var(--fs-sm);
  max-width: 22em;
}

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
  background-color: var(--border);
  margin: 1em 0;
}
.list-item {
  height: 100%;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 2em;
  padding: 1.5em;
  outline: 1px solid var(--border-muted);
  border-radius: 1em;
  &:hover {
    outline-color: var(--accent);
    background-color: var(--tint-1);
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
    --theme: var(--accent);
    display: block;
    padding: 0.5em 1em;
    border-radius: 0.5em;
    &:not(:disabled) {
      cursor: pointer;
      background-color: var(--theme);
      color: var(--text);
      border: 1px solid transparent;
      &:hover {
        filter: brightness(1.2);
      }
    }
    &:disabled {
      background-color: transparent;
      color: var(--text-disabled);
      border: 1px solid var(--border-muted);
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
    background-color: var(--bg-chrome);
  }
  .right {
    border-left: 2px solid var(--border);
    background-color: var(--bg-app);
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
      background: var(--tint-2);
      cursor: pointer;
      &:hover {
        background: var(--tint-4);
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
