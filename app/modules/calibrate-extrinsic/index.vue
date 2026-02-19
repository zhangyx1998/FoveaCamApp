<script setup lang="ts">
import {
  markRaw,
  onUnmounted,
  ref,
  shallowReactive,
  shallowRef,
  watch,
} from "vue";
import Calibrate from "./calibrate.vue";
import Finalize from "./finalize.vue";
import Preview from "./preview.vue";
import { createDataSet, ExtrinsicRecord } from "./calibrate";
import {
  useMatchedCameras,
  useIntrinsicCalibration,
  useExtrinsicCalibration,
  useExtrinsicRegression,
  ExtrinsicRegression,
} from "@lib/camera";
import Store from "@lib/store";
const cameras = await useMatchedCameras(true);
const { undistort } = await useIntrinsicCalibration(cameras.C);
const state = ref<"CAL" | "FIN" | "PRV">("CAL");
const L = shallowRef<ExtrinsicRegression | null>(null);
const R = shallowRef<ExtrinsicRegression | null>(null);

const records = await Store.open<ExtrinsicRecord[]>(
  ["tmp", "calibrate-extrinsic"],
  [],
);
const saved = ref(false);

watch(records, () => (saved.value = false));

function finalize() {
  state.value = "FIN";
  L.value = null;
  R.value = null;
  Promise.all([
    useExtrinsicRegression(createDataSet(records, "L")),
    useExtrinsicRegression(createDataSet(records, "R")),
  ]).then(([l, r]) => {
    L.value = l;
    R.value = r;
  });
}

function confirm() {
  saved.value = true;
  Promise.all([
    useExtrinsicCalibration(cameras.L).then((store) =>
      Object.assign(store, createDataSet(records, "L")),
    ),
    useExtrinsicCalibration(cameras.R).then((store) =>
      Object.assign(store, createDataSet(records, "R")),
    ),
  ]).then(() => console.log("Extrinsic calibration saved."));
}

onUnmounted(() => {
  cameras.release();
});
</script>

<template>
  <div v-if="!undistort">Missing intrinsic calibration data.</div>
  <template v-else-if="state === 'CAL'">
    <Calibrate
      :cameras="markRaw(cameras)"
      :undistort="undistort"
      :records="records"
      @finalize="finalize"
    />
  </template>
  <template v-else-if="state === 'FIN'">
    <Finalize
      :undistort="undistort"
      :records="records"
      :finalized="!!(L && R)"
      :saved="saved"
      @back="state = 'CAL'"
      @preview="state = 'PRV'"
      @confirm="confirm"
    />
  </template>
  <template v-else-if="state === 'PRV' && L && R">
    <Preview
      :cameras="markRaw(cameras)"
      :undistort="undistort"
      :saved="saved"
      :L="L"
      :R="R"
      @back="state = 'FIN'"
      @confirm="confirm"
    />
  </template>
</template>
