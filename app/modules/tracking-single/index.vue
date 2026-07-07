<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Single-target tracking, migrated to the orchestrator (first frame-driven
  control loop off the renderer). This module is now a thin client over the
  `tracking` session: the orchestrator leases the calibrated L/C/R triple, runs
  the KCF tracker on the center stream and the actuation loop, and streams L/C/R
  previews + tracker/voltage telemetry here. The renderer only renders frames,
  overlays telemetry, and drives parameters/commands — no `core`, camera, or
  calibration access.

  Display vision (undistorted center, sliced/diff/depth fovea views, perspective
  wrap) now runs in the orchestrator session and arrives here as processed frames.

  This module has no capture/recording of its own; manual-control's are
  orchestrator-side (modules/manual-control/{capture,recording}.ts) — reuse
  that session-side pattern here if ever needed.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { Point2d, Size } from "core/Geometry";
import { ROLE, THEME } from "@lib/camera-config";
import { useAppConfig } from "@lib/config";
import { useFrames, useSession } from "@lib/orchestrator/client";
import { tracking } from "./contract";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import Drawer from "@src/components/Drawer.vue";
import TrackingAnnotations from "./TrackingAnnotations.vue";

const app_config = await useAppConfig();
const session = useSession(tracking, "tracking");
// `state`/`telemetry` mirror the same shape the orchestrator session sees
// (§12.3 R3) — read/write them as plain reactive properties below, no `.value`.
const { state, telemetry } = session;

// Processed preview frames fanned from the orchestrator: C undistorted, L/R
// perspective-wrapped, `center` the magnified fovea crop around the target.
const { L: frameL, C: frameC, R: frameR, center: frameCenter } = useFrames(session, [
  "L",
  "C",
  "R",
  "center",
]);

const drawer_height = ref(0);

const distance = computed(() =>
  state.verge <= 0 ? Infinity : state.baseline / Math.pow(state.verge, 2),
);
const depth_window = computed(() =>
  state.depthWindowInv <= 0
    ? Infinity
    : 1 / Math.pow(state.depthWindowInv, 2),
);
const plusSign = (v: string) => (v.startsWith("-") ? v : "+" + v);

// WS2 2b: open/close the tracking debug sub-window (annotation overlay on the
// C stream), owned by this app window (cascade-closes on app close/switch).
const toggleDebug = () => window.foveaBridge.toggleDebugWindow("tracking", "C");

onMounted(() => {
  // Seed the stereo baseline from app config (single source for the geometry).
  if (app_config.baseline_distance_mm)
    state.baseline = app_config.baseline_distance_mm;
});

// Mouse: drag steers the target directly; releasing engages the tracker there.
const dragging = ref(false);
let lastSteer: Point2d = { x: 0, y: 0 };
function onCursor(c: (Point2d & Size & { buttons: number }) | null) {
  if (c) {
    dragging.value = true;
    lastSteer = { x: c.x, y: c.y };
    session.call("steer", lastSteer);
  } else if (dragging.value) {
    dragging.value = false;
    session.call("startTracker", lastSteer);
  }
}

const releaseTracker = () => session.call("releaseTracker", undefined);
</script>

<template>
  <div
    class="cameras"
    :style="{ '--p': (drawer_height ? drawer_height + 20 : 0) + 'px' }"
  >
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.L"
        :payload="frameL.payload.value" :source="frameL.source"
        :theme="THEME.L"
      />
      <PosView :pos="telemetry.volt.L" :color="THEME.L" style="width: 100%" />
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="'Fovea (' + state.view + ')'"
        :payload="frameCenter.payload.value" :source="frameCenter.source"
        :theme="THEME.C"
      />
      <StreamView
        class="stream"
        :title="ROLE.C"
        :payload="frameC.payload.value" :source="frameC.source"
        :theme="THEME.C"
        @mouse="onCursor"
      >
        <!-- Annotation overlay (A-21 / A-P6): extracted to a shared component,
             also rendered in the debug sub-window (WS2 2b). -->
        <TrackingAnnotations :session="session" />
      </StreamView>
      <ConfigEntry>
        <label>
          <span>Zoom</span>
          <input v-model.number="state.zoom" style="width: 4ch" />
        </label>
        <span>|</span>
        <label>
          <span>View</span>
          <select v-model="state.view">
            <option value="sliced">Sliced</option>
            <option value="diff">Diff</option>
            <option value="depth">Depth</option>
          </select>
        </label>
        <span>|</span>
        <label>
          <span>Wrap</span>
          <input type="checkbox" v-model="state.wrap" />
        </label>
        <span>|</span>
        <button class="debug-btn" title="Toggle the annotation overlay in its own window" @click="toggleDebug">
          Debug ▸
        </button>
        <span>|</span>
        <button v-if="telemetry.active" class="release-btn" @click="releaseTracker">
          Release Tracker
        </button>
        <span v-else class="tracker-idle">
          {{ telemetry.ready ? "Click center view to track" : "Calibrated triple not found" }}
        </span>
      </ConfigEntry>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.R"
        :payload="frameR.payload.value" :source="frameR.source"
        :theme="THEME.R"
      />
      <PosView :pos="telemetry.volt.R" :color="THEME.R" style="width: 100%" />
    </div>
  </div>
  <Drawer v-model="drawer_height">
    <div class="options fill">
      <RangeSlider v-model="state.verge" :min="1" :max="0" :neutral="0" :step="0.01">
        <span>Verge Distance</span>
        <span>
          <template v-if="distance !== Infinity">
            {{ (distance / 1000).toFixed(4) }}m
          </template>
          <template v-else> &#x221E; </template>
        </span>
      </RangeSlider>
      <RangeSlider v-model="state.shift" :min="-0.5" :max="+0.5" :neutral="0" :step="0.1">
        <span>Vertical Shift</span>
        <span> {{ plusSign(state.shift.toFixed(4)) }}&deg; </span>
      </RangeSlider>
      <RangeSlider
        v-model="state.depthWindowInv"
        :min="1"
        :max="0"
        :neutral="0"
        :step="0.01"
      >
        <span>Depth Window</span>
        <span>
          <template v-if="depth_window !== Infinity">
            {{ (depth_window / 1000).toFixed(4) }} m
          </template>
          <template v-else> &#x221E; </template>
        </span>
      </RangeSlider>
      <RangeSlider
        v-model="state.lost_tolerance"
        :min="1"
        :max="60"
        :neutral="10"
        :step="1"
      >
        <span>Lost Tolerance</span>
        <span>{{ state.lost_tolerance }} frames</span>
      </RangeSlider>
      <RangeSlider
        v-model="state.pred_buffer_max"
        :min="4"
        :max="50"
        :neutral="10"
        :step="1"
      >
        <span>Predict Samples</span>
        <span>{{ state.pred_buffer_max }} samples</span>
      </RangeSlider>
      <ConfigEntry>
        <label>
          <span>Tracker Size</span>
          <input v-model.number="state.tracker_w" style="width: 5ch" />
          <span>&times;</span>
          <input v-model.number="state.tracker_h" style="width: 5ch" />
        </label>
      </ConfigEntry>
      <ConfigEntry>
        <label>
          <span>Search Pad</span>
          <input v-model.number="state.pad_x" style="width: 5ch" />
          <span>&times;</span>
          <input v-model.number="state.pad_y" style="width: 5ch" />
        </label>
      </ConfigEntry>
    </div>
  </Drawer>
</template>

<style scoped lang="scss">
.cameras {
  position: relative;
  display: flex;
  justify-content: space-evenly;
  align-items: flex-start;
  flex-wrap: wrap;
  flex-direction: row;
  width: 100%;
  --p: 0;
  padding: 1em 0 calc(1em + var(--p)) 0;
  margin: 0;

  & > * {
    width: 30vw;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
  }

  .stream {
    width: 30vw;
    height: 22.5vw;
  }
}

.fill {
  width: 100%;
  height: 100%;
}

.options {
  padding: 1em;
  overflow-x: hidden;
  overflow-y: scroll;
  & > * {
    height: 2em;
  }
}

.release-btn {
  background: none;
  border: 1px solid #0f0;
  color: #0f0;
  padding: 0.1em 0.6em;
  cursor: pointer;
  font-size: 0.85em;
  border-radius: 3px;
  &:hover {
    background: #0f02;
  }
}

.debug-btn {
  background: none;
  border: 1px solid #58a;
  color: #8cf;
  padding: 0.1em 0.6em;
  cursor: pointer;
  font-size: 0.85em;
  border-radius: 3px;
  &:hover {
    background: #58a2;
  }
}

.tracker-idle {
  color: #666;
  font-size: 0.85em;
}
</style>
