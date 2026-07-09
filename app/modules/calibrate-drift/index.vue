<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Per-fovea drift measurement, migrated to the orchestrator (docs/history/refactor/
  orchestrator.md §7.1 S1b). Thin client over the `calibrate-drift` session:
  the orchestrator runs three simultaneous marker trackers and a background
  visual servo; this view renders the three streams + derived/saved drift
  readouts and drives target-id/override/commit via commands. The
  `controller` session is read directly for `pos`/`dv` (`PosView`), same as
  every other control-loop module now that the serial device is orchestrator-
  owned.
-->
<script setup lang="ts">
import { computed } from "vue";
import { ROLE, THEME } from "@lib/camera-config";
import { useAppConfig } from "@lib/config";
import { useController, useSession, usePipeFrame, usePidOverride } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { calibrateDrift } from "./contract";
import Recording from "@src/record";
import StreamView from "@src/components/StreamView.vue";
import PosView, { type Pos } from "@src/components/PosView.vue";
import MarkerTargetInputs from "@src/components/MarkerTargetInputs.vue";
import Drift from "./Drift.vue";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";
import Marker from "@src/graphics/Marker.vue";
import CrossHair from "@src/graphics/CrossHair.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import Drawer from "@src/components/Drawer.vue";
import { driftUpdatable } from "./drift-gate";
import type { Point2d } from "core/Geometry";

const app_config = await useAppConfig();
const session = useSession(calibrateDrift, "calibrate-drift");
const ctrl = useController();
const { state, telemetry } = session;
// Recording context (capture-recorder-everywhere ruling 2): title-bar
// RecordButton + Cmd/Ctrl-R over the session's startRecording/stopRecording.
new Recording(session, "calibrate-drift");

// Derived-vs-saved delta per eye (proposal finding 7). `updatable*` also gates
// the Update buttons: a derived drift within the tracker's measurement-noise
// floor of what's saved is churn, not signal (see drift-gate.ts).
function delta(derived: Point2d | null, saved: Point2d | null): Point2d | null {
  if (!derived) return null;
  return { x: derived.x - (saved?.x ?? 0), y: derived.y - (saved?.y ?? 0) };
}
const deltaL = computed(() => delta(telemetry.derived.L, telemetry.saved.L));
const deltaR = computed(() => delta(telemetry.derived.R, telemetry.saved.R));
const updatableL = computed(() => driftUpdatable(telemetry.derived.L, telemetry.saved.L));
const updatableR = computed(() => driftUpdatable(telemetry.derived.R, telemetry.saved.R));

// C-22: raw L/C/R previews now ride the native `camera:<serial>` pipe (off the
// JS view-tap loop) via `usePipeFrame`; the marker-detection overlays are drawn
// client-side from `telemetry.detection`, unchanged.
const pipe = (role: "L" | "C" | "R") =>
  usePipeFrame(() => (state.serials?.[role] ? nodeId.convert(state.serials[role]) : null));
const frameL = pipe("L");
const frameC = pipe("C");
const frameR = pipe("R");

function stroke(): number {
  return 3;
}

const marker_size = computed(() => app_config.cal_marker_size_mm);
const marker_ratio = computed(() => app_config.cal_marker_ratio);
const center_marker_size = computed(() => marker_size.value * marker_ratio.value);

// Per-eye PID-node override proxies (reusable `pidOverride` fragment). Dragging
// a `PosView` sets that eye's `value` (engage/pin the servo output); releasing
// the drag emits null → the proxy releases (control resumes from the released
// pose via the servo node's `seed`).
const overrideL = usePidOverride<typeof calibrateDrift, Pos>(session, {
  stateKey: "pidOverrideL",
  command: "pidOverrideL",
});
const overrideR = usePidOverride<typeof calibrateDrift, Pos>(session, {
  stateKey: "pidOverrideR",
  command: "pidOverrideR",
});
</script>

<template>
  <div class="cameras">
    <div class="view">
      <StreamView class="stream" :title="ROLE.L" :payload="frameL" :theme="THEME.L">
        <circle
          v-for="(p, i) in telemetry.detection.L?.points ?? []"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          :r="stroke()"
          :fill="THEME.L"
        />
      </StreamView>
      <MarkerTargetInputs :session="session" role="L" :detected="!!telemetry.detection.L" />
      <Drift :drift="telemetry.derived.L">Derived Drift</Drift>
      <Drift :drift="deltaL">&Delta; vs Saved</Drift>
      <PosView
        v-if="ctrl.telemetry.connected"
        :pos="ctrl.telemetry.pos.left"
        :lim="ctrl.telemetry.dv"
        :color="THEME.L"
        style="width: 100%"
        :font-size="12"
        @select="(p) => (overrideL.value = p)"
      />
    </div>
    <div class="view">
      <StreamView class="stream" :title="ROLE.C" :payload="frameC" :theme="THEME.C">
        <circle
          v-for="(p, i) in telemetry.detection.C?.points ?? []"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          :r="stroke()"
          :fill="THEME.C"
        />
      </StreamView>
      <MarkerTargetInputs :session="session" role="C" :detected="!!telemetry.detection.C" />
      <div class="actions">
        <button :disabled="!updatableL" @click="session.call('updateDrift', { role: 'L' })">
          Update Drift (L)
        </button>
        <button
          :disabled="!updatableL || !updatableR"
          @click="session.call('updateDrift', { role: 'ALL' })"
        >
          Update Drift (All)
        </button>
        <button :disabled="!updatableR" @click="session.call('updateDrift', { role: 'R' })">
          Update Drift (R)
        </button>
      </div>
      <Drift :drift="telemetry.saved.L">Saved Drift (L)</Drift>
      <Drift :drift="telemetry.saved.R">Saved Drift (R)</Drift>
    </div>
    <div class="view">
      <StreamView class="stream" :title="ROLE.R" :payload="frameR" :theme="THEME.R">
        <circle
          v-for="(p, i) in telemetry.detection.R?.points ?? []"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          :r="stroke()"
          :fill="THEME.R"
        />
      </StreamView>
      <MarkerTargetInputs :session="session" role="R" :detected="!!telemetry.detection.R" />
      <Drift :drift="telemetry.derived.R">Derived Drift</Drift>
      <Drift :drift="deltaR">&Delta; vs Saved</Drift>
      <PosView
        v-if="ctrl.telemetry.connected"
        :pos="ctrl.telemetry.pos.right"
        :lim="ctrl.telemetry.dv"
        :color="THEME.R"
        style="width: 100%"
        :font-size="12"
        @select="(p) => (overrideR.value = p)"
      />
    </div>
  </div>
  <Drawer>
    <div class="options fill">
      <RangeSlider v-model="app_config.cal_marker_size_mm" :min="10" :max="120" :neutral="60" :step="1">
        <span>Marker Size</span>
        <span>{{ app_config.cal_marker_size_mm.toFixed(1) }} mm</span>
      </RangeSlider>
      <RangeSlider v-model="app_config.cal_marker_ratio" :min="0.2" :max="1.2" :neutral="1.0" :step="0.02">
        <span>Center Marker</span>
        <span>{{ (app_config.cal_marker_ratio * 100).toFixed(0) }}%</span>
      </RangeSlider>
    </div>
  </Drawer>
  <RemoteCanvasTeleport>
    <CrossHair
      :cx="app_config.baseline_distance_mm / 2 + marker_size"
      :cy="center_marker_size"
      weight="2"
    />
    <Marker :id="state.targetId.L" :size="marker_size" :cx="-app_config.baseline_distance_mm / 2" />
    <Marker :id="state.targetId.R" :size="marker_size" :cx="app_config.baseline_distance_mm / 2" />
    <Marker :id="state.targetId.C" :size="center_marker_size" />
  </RemoteCanvasTeleport>
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
  padding: 1em 0;
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

.actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 1rem;
  width: 100%;
  margin: 1em 0;
  & > * {
    display: block;
    width: 0;
    flex-grow: 1;
    height: 2rem;
  }
}
</style>
