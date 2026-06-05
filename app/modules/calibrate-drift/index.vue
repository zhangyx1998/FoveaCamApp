<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { MarkerDetector } from "core/Vision";
import { Point2d } from "core/Geometry";
import { ROLE, THEME, useCalibratedTriple } from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
import PosView, { Pos } from "@src/components/PosView.vue";
import { getController } from "@src/components/Controller.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import Tracker, { actuate } from "@modules/calibrate-extrinsic/tracker";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import MarkerDetection from "@modules/calibrate-extrinsic/MarkerDetection.vue";
import Drift from "./Drift.vue";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";
import Marker from "@src/graphics/Marker.vue";
import CrossHair from "@src/graphics/CrossHair.vue";
import { useAppConfig } from "@lib/config";
import RangeSlider from "@src/inputs/range-slider.vue";
import Drawer from "@src/components/Drawer.vue";

const app_config = await useAppConfig();

const controller = computed(getController);
const { L, C, R, CI, LE, RE, config, release } = await useCalibratedTriple();
const undistort = CI.undistort!;
if (!undistort)
  throw new Error("Intrinsic calibration not found for center camera.");

const detector = new MarkerDetector("4X4_50");

const tracker = {
  L: new Tracker(L, detector, 1, 0.25),
  C: new Tracker(C, detector, 0, 1.0),
  R: new Tracker(R, detector, 2, 0.25),
};

const override: { left: Pos | null; right: Pos | null } = {
  left: null,
  right: null,
};

const angular = computed(() => {
  if (!tracker.C.center_absolute) return null;
  return undistort.angular([tracker.C.center_absolute], true)[0];
});

function applyDrift(r: Point2d, d: Point2d = { x: 0, y: 0 }) {
  return {
    x: r.x + d.x,
    y: r.y + d.y,
  };
}

function deriveDrift(fovea: Point2d | null) {
  const r = angular.value;
  return r && fovea
    ? {
        x: r.x - fovea.x,
        y: r.y - fovea.y,
      }
    : null;
}

const derived = {
  get L() {
    return (
      tracker.L.target &&
      controller.value &&
      deriveDrift(LE.V2A.predict(controller.value.pos.left))
    );
  },
  get R() {
    return (
      tracker.R.target &&
      controller.value &&
      deriveDrift(RE.V2A.predict(controller.value.pos.right))
    );
  },
};

const actuator = computed(
  () =>
    controller.value &&
    actuate(
      controller.value,
      tracker.L,
      tracker.R,
      {
        kp: 10.0,
        get origin_left() {
          const r = angular.value;
          return r
            ? LE.A2V.predict(applyDrift(r, config.drift_l))
            : { x: 0, y: 0 };
        },
        get origin_right() {
          const r = angular.value;
          return r
            ? RE.A2V.predict(applyDrift(r, config.drift_r))
            : { x: 0, y: 0 };
        },
      },
      override,
    ),
);

const marker_size = computed(() => app_config.cal_marker_size_mm);
const marker_ratio = computed(() => app_config.cal_marker_ratio);
const center_marker_size = computed(
  () => marker_size.value * marker_ratio.value,
);

watch(actuator, (_, prev) => prev?.abort());

onUnmounted(async () => {
  await Promise.all([
    tracker.L.task.abort(),
    tracker.C.task.abort(),
    tracker.R.task.abort(),
    actuator.value?.abort(),
  ]);
  release();
});
</script>

<template>
  <div class="cameras">
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.L"
        :footnote="`Marker Tracker @ ${tracker.L.fps ?? 'N/A'}`"
        :camera="L"
        :theme="THEME.L"
      >
        <MarkerDetection
          v-if="tracker.L.target"
          :detection="tracker.L.target"
        />
        <MarkerDetection
          v-for="(d, i) in tracker.L.other_targets"
          :key="i"
          :detection="d"
          color="gray"
        />
      </StreamView>
      <ConfigEntry>
        <span>
          {{ tracker.L.target ? "✓" : "✗" }}
          Marker ID to Track:
        </span>
        <input type="number" v-model.number="tracker.L.target_id" step="1" />
      </ConfigEntry>
      <Drift :drift="derived.L">Derived Drift</Drift>
      <PosView
        v-if="controller"
        :pos="controller.pos.left"
        :lim="controller.dv"
        :color="THEME.L"
        style="width: 100%"
        :font-size="12"
        @select="(p) => (override.left = p)"
      ></PosView>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.C"
        :footnote="`Marker Tracker @ ${tracker.C.fps ?? 'N/A'}`"
        :camera="C"
        :theme="THEME.C"
      >
        <MarkerDetection
          v-if="tracker.C.target"
          :detection="tracker.C.target"
        />
        <MarkerDetection
          v-for="(d, i) in tracker.C.other_targets"
          :key="i"
          :detection="d"
          color="gray"
        />
        <FrameCursor
          v-if="tracker.C.center_absolute"
          :cursor="tracker.C.center_absolute"
          :undistort="undistort"
          box="rect"
        />
      </StreamView>
      <ConfigEntry>
        <span>
          {{ tracker.C.target ? "✓" : "✗" }}
          Marker ID to Track:
        </span>
        <input type="number" v-model.number="tracker.C.target_id" step="1" />
      </ConfigEntry>
      <div class="actions">
        <button
          :disabled="!derived.L"
          @click="config.drift_l = { ...derived.L! }"
          @keydown.backspace.prevent="config.drift_l = undefined"
        >
          Update Drift (L)
        </button>
        <button
          :disabled="!derived.L || !derived.R"
          @click="
            config.drift_l = { ...derived.L! };
            config.drift_r = { ...derived.R! };
          "
          @keydown.backspace.prevent="
            config.drift_l = undefined;
            config.drift_r = undefined;
          "
        >
          Update Drift (All)
        </button>
        <button
          :disabled="!derived.R"
          @click="config.drift_r = { ...derived.R! }"
          @keydown.backspace.prevent="config.drift_r = undefined"
        >
          Update Drift (R)
        </button>
      </div>
      <Drift :drift="config.drift_l">Saved Drift (L)</Drift>
      <Drift :drift="config.drift_r">Saved Drift (R)</Drift>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.R"
        :footnote="`Marker Tracker @ ${tracker.R.fps ?? 'N/A'}`"
        :camera="R"
        :theme="THEME.R"
      >
        <MarkerDetection
          v-if="tracker.R.target"
          :detection="tracker.R.target"
        />
        <MarkerDetection
          v-for="(d, i) in tracker.R.other_targets"
          :key="i"
          :detection="d"
          color="gray"
        />
      </StreamView>
      <ConfigEntry>
        <span>
          {{ tracker.R.target ? "✓" : "✗" }}
          Marker ID to Track:
        </span>
        <input
          type="number"
          v-model.number="tracker.R.target_id"
          style="width: 2ch"
        />
      </ConfigEntry>
      <Drift :drift="derived.R">Derived Drift</Drift>
      <PosView
        v-if="controller"
        :pos="controller.pos.right"
        :lim="controller.dv"
        :color="THEME.R"
        style="width: 100%"
        :font-size="12"
        @select="(p) => (override.right = p)"
      ></PosView>
    </div>
  </div>
  <Drawer>
    <div class="options fill">
      <RangeSlider
        v-model="app_config.cal_marker_size_mm"
        :min="10"
        :max="120"
        :neutral="60"
        :step="1"
      >
        <span>Marker Size</span>
        <span>{{ app_config.cal_marker_size_mm.toFixed(1) }} mm</span>
      </RangeSlider>
      <RangeSlider
        v-model="app_config.cal_marker_ratio"
        :min="0.2"
        :max="1.2"
        :neutral="1.0"
        :step="0.02"
      >
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
    <Marker
      :id="tracker.L.target_id"
      :size="marker_size"
      :cx="-app_config.baseline_distance_mm / 2"
    />
    <Marker
      :id="tracker.R.target_id"
      :size="marker_size"
      :cx="app_config.baseline_distance_mm / 2"
    />
    <Marker :id="tracker.C.target_id" :size="center_marker_size" />
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
