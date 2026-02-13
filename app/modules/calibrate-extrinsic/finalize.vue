<script setup lang="ts">
import { Point2d } from "core/Geometry";
import type { Undistort } from "core/Vision";
import { ROLE, THEME } from "@lib/camera";
import FrameView from "@src/components/FrameView.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import NavBack from "@src/components/NavBack.vue";
import { ExtrinsicRecord } from "./calibrate";
import Marker from "./MarkerDetection.vue";

const props = defineProps<{
  undistort: Undistort;
  records: ExtrinsicRecord[];
  finalized: boolean;
  saved: boolean;
}>();

const emit = defineEmits<{
  (e: "back"): void;
  (e: "preview"): void;
  (e: "confirm"): void;
}>();

function cursor(angle: Point2d) {
  return {
    ...props.undistort.position([angle], true)[0],
    ...props.undistort.sensor_size,
  };
}
</script>

<template>
  <div class="finalize" style="padding-top: 4em">
    <template v-for="({ L, C, R }, i) in records" :key="i">
      <div class="divider" v-if="i > 0"></div>
      <div class="record">
        <FrameView width="30%" :title="ROLE.L" :theme="THEME.L">
          <Marker
            :detection="L.img_pts"
            :features="L.img_pts"
            :color="THEME.L"
          />
        </FrameView>
        <FrameView width="30%" :title="ROLE.C" :theme="THEME.C">
          <Marker
            :detection="C.img_pts"
            :features="C.img_pts"
            :color="THEME.C"
          />
          <FrameCursor
            :cursor="cursor(C.angle)"
            :undistort="undistort"
            box="rect"
          />
        </FrameView>
        <FrameView width="30%" :title="ROLE.R" :theme="THEME.R">
          <Marker
            :detection="R.img_pts"
            :features="R.img_pts"
            :color="THEME.R"
          />
        </FrameView>
      </div>
    </template>
    <NavBack @click="emit('back')">
      <span>Back to Calibration</span>
      <div style="flex-grow: 1"></div>
      <button :disabled="!finalized" @click="emit('preview')">
        Preview Results
      </button>
      <button :disabled="false" @click="emit('confirm')">
        Confirm and Save
      </button>
    </NavBack>
  </div>
</template>

<style scoped lang="scss">
.finalize {
  width: 100%;
  max-height: 100%;
  overflow-y: scroll;
  display: flex;
  flex-direction: column;
  overflow: auto;
  align-items: stretch;
  padding: 2em;
  gap: 2em;
  box-sizing: border-box;

  .record {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-evenly;
    flex-grow: 1;
  }

  .divider {
    width: 100%;
    height: 1px;
    background-color: #333;
  }
}
</style>
