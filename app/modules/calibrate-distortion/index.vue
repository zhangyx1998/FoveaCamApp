<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Projector-alignment/homography validation, migrated to the orchestrator
  (docs/refactor/orchestrator.md §7.1 S1b). Thin client over the
  `calibrate-distortion` session: three marker trackers, a continuous
  "point mirrors at the tracked wide-angle marker" actuation loop, and a
  live per-fovea homography preview. `controller` session read directly for
  the position readout in the stream titles.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { ROLE, THEME } from "@lib/camera-config";
import { useAppConfig } from "@lib/config";
import { useController, useFrames, useSession } from "@lib/orchestrator/client";
import { formatNumber, type FormatNumberOptions } from "@lib/util";
import { createMat } from "@lib/mat";
import type { Point2d } from "core/Geometry";
import { calibrateDistortion } from "./contract";
import StreamView from "@src/components/StreamView.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import MarkerTargetInputs from "@src/components/MarkerTargetInputs.vue";
import Matrix from "@src/components/Matrix.vue";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";
import Marker from "@src/graphics/Marker.vue";

const app_config = await useAppConfig();
const session = useSession(calibrateDistortion, "calibrate-distortion");
const ctrl = useController();
const { state, telemetry } = session;

const {
  L: frameL,
  C: frameC,
  R: frameR,
  proj_L: frameProjL,
  proj_R: frameProjR,
} = useFrames(session, ["L", "C", "R", "proj_L", "proj_R"]);

const marker_zoom = ref(1.0);

function formatPos(pos?: Point2d): string {
  if (!pos) return "X ---, Y ---";
  const options: FormatNumberOptions = { unit: "V", plusSign: true, decimals: 2, digitsBeforePoint: 3 };
  return `X ${formatNumber(pos.x, options)}, Y ${formatNumber(pos.y, options)}`;
}

function toMat(H: number[]) {
  const m = createMat(Float64Array, [3, 3]);
  m.set(H);
  return m;
}

</script>

<template>
  <div class="cameras">
    <div class="view">
      <StreamView
        class="stream"
        :title="[ROLE.L, formatPos(ctrl.telemetry.pos.left)].join(' | ')"
        :payload="frameL"
        :theme="THEME.L"
      >
        <circle
          v-for="(p, i) in telemetry.detection.L?.points ?? []"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          r="4"
          :fill="THEME.L"
        />
      </StreamView>
      <MarkerTargetInputs :session="session" role="L" :detected="!!telemetry.detection.L" width="8ch" />
      <StreamView class="stream" title="Homography Projection" :payload="frameProjL" :theme="THEME.L">
        <circle
          v-for="(p, i) in telemetry.projection.L?.points ?? []"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          r="4"
          :fill="THEME.L"
        />
      </StreamView>
      <Matrix v-if="telemetry.projection.L" :mat="toMat(telemetry.projection.L.H)" :round="2" />
    </div>
    <div class="view">
      <StreamView class="stream" :title="ROLE.C" :payload="frameC" :theme="THEME.C">
        <circle
          v-for="(p, i) in telemetry.detection.C?.points ?? []"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          r="4"
          :fill="THEME.C"
        />
      </StreamView>
      <MarkerTargetInputs :session="session" role="C" :detected="!!telemetry.detection.C" width="8ch" />
      <ConfigEntry>
        <span>Marker Size (mm):</span>
        <input type="number" step="1" style="width: 8ch" v-model.number="app_config.cal_marker_size_mm" />
      </ConfigEntry>
      <ConfigEntry>
        <span>Marker Zoom:</span>
        <input type="number" step="0.1" style="width: 8ch" v-model.number="marker_zoom" />
      </ConfigEntry>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="[ROLE.R, formatPos(ctrl.telemetry.pos.right)].join(' | ')"
        :payload="frameR"
        :theme="THEME.R"
      >
        <circle
          v-for="(p, i) in telemetry.detection.R?.points ?? []"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          r="4"
          :fill="THEME.R"
        />
      </StreamView>
      <MarkerTargetInputs :session="session" role="R" :detected="!!telemetry.detection.R" width="8ch" />
      <StreamView class="stream" title="Homography Projection" :payload="frameProjR" :theme="THEME.R">
        <circle
          v-for="(p, i) in telemetry.projection.R?.points ?? []"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          r="4"
          :fill="THEME.R"
        />
      </StreamView>
      <Matrix v-if="telemetry.projection.R" :mat="toMat(telemetry.projection.R.H)" :round="2" />
    </div>
  </div>
  <RemoteCanvasTeleport>
    <Marker :id="state.target_id.L" :size="app_config.cal_marker_size_mm * marker_zoom" :cx="-app_config.baseline_distance_mm / 2" />
    <Marker :id="state.target_id.R" :size="app_config.cal_marker_size_mm * marker_zoom" :cx="app_config.baseline_distance_mm / 2" />
    <Marker :id="state.target_id.C" :size="app_config.cal_marker_size_mm / marker_zoom" />
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
</style>
