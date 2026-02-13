<script setup lang="ts">
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faArrowsRotate } from "@fortawesome/free-solid-svg-icons";
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
import RangeSlider from "@src/inputs/range-slider.vue";
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

const sliderTest = ref(0);
</script>

<template>
  <div class="content">
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
    <ConfigEntry>
      <span>Angle X</span>
      <input
        type="range"
        v-model.number="rx"
        min="-45"
        max="45"
        style="width: 12ch"
      />
      <span style="min-width: 8ch; text-align: right"
        >{{ rx.toFixed(2) }}°</span
      >
      <button @click="rx = 0">
        <Icon :icon="faArrowsRotate" />
      </button>
    </ConfigEntry>
    <ConfigEntry>
      <span>Angle Y</span>
      <input
        type="range"
        v-model.number="ry"
        min="-45"
        max="45"
        style="width: 12ch"
      />
      <span style="min-width: 8ch; text-align: right">
        {{ ry.toFixed(2) }}°
      </span>
      <button @click="ry = 0">
        <Icon :icon="faArrowsRotate" />
      </button>
    </ConfigEntry>
    <ConfigEntry>
      <span>Distance</span>
      <input
        type="range"
        v-model.number="d"
        min="1"
        max="100"
        style="width: 12ch"
      />
      <span style="min-width: 8ch; text-align: right">
        {{ d.toFixed(2) }}
      </span>
      <button @click="d = 1">
        <Icon :icon="faArrowsRotate" />
      </button>
    </ConfigEntry>
    <ConfigEntry>
      <span>Distance</span>
      <input
        type="range"
        v-model.number="d"
        min="1"
        max="100"
        style="width: 12ch"
      />
      <span style="min-width: 8ch; text-align: right">
        {{ d.toFixed(2) }}
      </span>
      <button @click="d = 1">
        <Icon :icon="faArrowsRotate" />
      </button>
    </ConfigEntry>
    <RangeSlider
      v-model="sliderTest"
      :min="-100"
      :max="+100"
      :neutral="0"
      style="width: 40ch"
    >
      <span>Hello World</span>
      <span>{{ sliderTest.toFixed(2) }}</span>
    </RangeSlider>
  </div>
</template>

<style scoped lang="scss">
.content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: 100%;
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
</style>
