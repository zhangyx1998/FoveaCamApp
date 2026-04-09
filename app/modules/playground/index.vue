<script setup lang="ts">
import ConfigEntry from "@src/components/ConfigEntry.vue";
import Marker from "@src/graphics/Marker.vue";
import { computed, ref } from "vue";
import {
  bilinearInterpolate,
  CORNER_OBJ_POINTS,
  getInternalObjectPoints,
  transformPoints,
} from "@lib/marker.js";
import { MarkerDetector } from "core/Vision";
import { Point2d } from "core/Geometry";
import { radians } from "@lib/util";
import Drawer from "@src/components/Drawer.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import SetPoints from "@src/set-points";
import SetPointsEditor from "@src/set-points/Editor.vue";
import SetPointsList from "@src/set-points/List.vue";
import { Scale } from "@lib/util/math";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";

const marker_id = ref(0);
const rx = ref(0);
const ry = ref(0);
const d = ref(1);
const detector = new MarkerDetector("4X4_50");
const corners = CORNER_OBJ_POINTS;
const obj_points = computed(() =>
  Array.from(getInternalObjectPoints(detector.pattern(marker_id.value))),
);
function project(corners: Point2d[], internals: Point2d[]) {
  return [...corners, ...bilinearInterpolate(corners, internals)];
}

const drawer_height = ref(0);
const points = new SetPoints();
</script>

<template>
  <div class="content" :style="{ paddingBottom: drawer_height + 'px' }">
    <div class="view">
      <svg viewBox="-1 -1 2 2">
        <Marker :id="marker_id" :cx="0" :cy="0" :size="1" opacity="0.2" />
        <circle
          v-for="(p, i) in project(corners, obj_points)"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          r="0.02"
          fill="yellow"
        />
      </svg>
      <svg viewBox="-1 -1 2 2">
        <circle
          v-for="(p, i) in transformPoints(
            project(corners, obj_points),
            { x: radians(rx), y: radians(ry) },
            d,
          )"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          r="0.02"
          fill="cyan"
        />
      </svg>
      <svg viewBox="-1 -1 2 2">
        <circle
          v-for="(p, i) in transformPoints(
            project(corners, obj_points),
            { x: radians(rx), y: radians(ry) },
            Infinity,
          )"
          :key="i"
          :cx="p.x"
          :cy="p.y"
          r="0.02"
          fill="magenta"
        />
      </svg>
    </div>
  </div>
  <Drawer v-model="drawer_height" :toggle="true">
    <HorizontalDivision
      :division="0.6"
      class="fill"
      :min-width-left="0.2"
      :min-width-right="0.2"
    >
      <template #left>
        <HorizontalDivision
          :division="0.5"
          class="fill"
          :min-width-left="0.3"
          :min-width-right="0.3"
        >
          <template #left>
            <SetPointsEditor :points="points" />
          </template>
          <template #right>
            <SetPointsList
              :points="points"
              :unit="['°', '°', Scale.millimeters]"
            />
          </template>
        </HorizontalDivision>
      </template>
      <template #right>
        <div class="fill pad">
          <ConfigEntry>
            <span>Marker ID:</span>
            <input
              type="number"
              v-model.number="marker_id"
              step="1"
              min="0"
              style="width: 8ch"
            />
          </ConfigEntry>
          <RangeSlider
            v-model.number="rx"
            :min="-45"
            :max="45"
            :step="0.1"
            :neutral="0"
            style="max-width: 40ch"
          >
            <span>Angle X</span>
            <span>{{ rx.toFixed(2) }}°</span>
          </RangeSlider>
          <RangeSlider
            v-model.number="ry"
            :min="-45"
            :max="45"
            :step="0.1"
            :neutral="0"
            style="max-width: 40ch"
          >
            <span>Angle Y</span>
            <span>{{ ry.toFixed(2) }}°</span>
          </RangeSlider>
          <RangeSlider
            v-model.number="d"
            :min="1"
            :max="100"
            :step="0.1"
            style="max-width: 40ch"
          >
            <span>Distance</span>
            <span>{{ d.toFixed(2) }}</span>
          </RangeSlider>
        </div>
      </template>
    </HorizontalDivision>
  </Drawer>
  <RemoteCanvasTeleport>
    <Marker :id="1" :size="60" :cx="-100" />
    <Marker :id="0" :size="60" />
    <Marker :id="2" :size="60" :cx="+100" />
  </RemoteCanvasTeleport>
</template>

<style scoped lang="scss">
.content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  width: 100%;
  min-height: 100%;
  --size: min(25vw, 50vh);
  .view {
    display: flex;
    flex-direction: row;
    justify-content: space-evenly;
    align-items: center;
    width: 100%;
    margin: 2rem 0;
    svg {
      outline: 4px solid #fff4;
      width: var(--size);
      height: var(--size);
      &:hover {
        outline-color: #fff8;
      }
      &:active {
        outline-color: #08fa;
      }
    }
  }
}

.fill {
  width: 100%;
  height: 100%;
}

.pad {
  padding: 1rem;
  box-sizing: border-box;
}
</style>
