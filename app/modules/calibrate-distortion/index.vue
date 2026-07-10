<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Projector-alignment/homography validation, migrated to the orchestrator
  (docs/history/refactor/orchestrator.md §7.1 S1b). Thin client over the
  `calibrate-distortion` session: three marker trackers, a continuous
  "point mirrors at the tracked wide-angle marker" actuation loop, and a
  live per-fovea homography preview. `controller` session read directly for
  the position readout in the stream titles.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { ROLE, THEME } from "@lib/camera-config";
import { useAppConfig } from "@lib/config";
import { useTripleBaseline } from "@lib/triple-baseline";
import { useController, useFrames, useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { formatNumber, type FormatNumberOptions } from "@lib/util";
import { createMat } from "@lib/mat";
import type { Point2d } from "core/Geometry";
import { calibrateDistortion } from "./contract";
import Recording from "@src/record";
import Capture from "@src/capture";
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
// Recording context (capture-recorder-everywhere ruling 2).
new Recording(session, "calibrate-distortion");
// Capture context (capture-recorder-everywhere ruling 3): lights this window's
// camera icon (AppWindow) → the shared CapturePreview window (its in-window
// button drives the shot). Per-window singleton, disposed on unmount.
new Capture(session, "calibrate-distortion");

// C-2c: raw fovea previews (L/C/R) all ride their native camera:<serial>
// convert pipe directly (off the JS view-tap relay loop); only the
// worker-derived homography overlays (proj_*) stay on session.frame.
const { proj_L: frameProjL, proj_R: frameProjR } = useFrames(session, ["proj_L", "proj_R"]);
const frameL = usePipeFrame(() =>
  state.serials?.L ? nodeId.convert(state.serials.L) : null,
);
const frameC = usePipeFrame(() =>
  state.serials?.C ? nodeId.convert(state.serials.C) : null,
);
const frameR = usePipeFrame(() =>
  state.serials?.R ? nodeId.convert(state.serials.R) : null,
);

const marker_zoom = ref(1.0);
// LIVE per-triple baseline (Ruling A): the L/R marker pair sits at ±baseline/2,
// resolved from the leased triple's `baseline_mm` (legacy app value, else 200)
// reactively — Settings edits reflect without a restart.
const baseline = useTripleBaseline(() => state.configPath, app_config);

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
      <StreamView class="stream" title="Homography Projection" :payload="frameProjL.payload.value" :source="frameProjL.source" :theme="THEME.L">
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
      <StreamView class="stream" title="Homography Projection" :payload="frameProjR.payload.value" :source="frameProjR.source" :theme="THEME.R">
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
    <Marker :id="state.targetId.L" :size="app_config.cal_marker_size_mm * marker_zoom" :cx="-baseline / 2" />
    <Marker :id="state.targetId.R" :size="app_config.cal_marker_size_mm * marker_zoom" :cx="baseline / 2" />
    <Marker :id="state.targetId.C" :size="app_config.cal_marker_size_mm / marker_zoom" />
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
