<script setup lang="ts">
import { CaptureData, current_capture, Resource, SaveState } from ".";
import SaveControls from "./SaveControls.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import { computed, reactive, ref, shallowReactive, shallowRef } from "vue";
import PreviewMeta from "./preview-meta/index.vue";
import PreviewImage from "./preview-image/index.vue";
import { isEmpty } from "@lib/util";
import SaveReport from "./SaveReport.vue";
const emit = defineEmits(["exit"]);
const capture = current_capture.value;
if (isEmpty(capture))
  throw new Error("Overlay must be used within a Capture context");

const data = shallowReactive<CaptureData>(new Map());
const data_ready = ref(false);
capture.capture(data).then((d) => {
  data_ready.value = true;
  console.log("Capture data:", d === data, Object.fromEntries(data.entries()));
});

const save_state = shallowRef<SaveState | null>(null);

function save(path: string, img_fmt: string) {
  if (save_state.value !== null) return;
  if (isEmpty(capture)) return;
  save_state.value = capture.save(path, data, img_fmt);
}

function* dataEntries() {
  for (const [name, res] of data.entries()) {
    if (!isEmpty(res)) yield { name, res };
  }
}

const meta_entries = computed(() => {
  const entries: [string, any][] = [];
  for (const { name, res } of dataEntries()) {
    if (Array.isArray(res)) {
      entries.push([name, res.map((r) => r.meta)]);
    } else {
      entries.push([name, res.meta]);
    }
  }
  console.log("meta_entries", entries);
  return entries;
});

const image_entries = computed(() => {
  const entries: [string, any][] = [];
  for (const { name, res } of dataEntries()) {
    if (Array.isArray(res)) {
      entries.push([name, res.map((r) => r.image)]);
    } else {
      entries.push([name, res.image]);
    }
  }
  console.log("image_entries", entries);
  return entries;
});
</script>

<template>
  <div class="container">
    <SaveControls
      style="height: 4rem"
      :capture="capture"
      @save="save"
      @exit="emit('exit')"
      :data_ready="data_ready"
      :save_state="save_state !== null"
    />
    <HorizontalDivision class="content" v-if="save_state === null">
      <template #left>
        <div class="meta-container">
          <PreviewMeta
            v-for="[name, meta] of meta_entries"
            :key="name"
            :name="name"
            :meta="meta"
          />
        </div>
      </template>
      <template #right>
        <div class="frame-container">
          <PreviewImage
            v-for="[name, image] of image_entries"
            :key="name"
            :name="name"
            :image="image"
          />
        </div>
      </template>
    </HorizontalDivision>
    <SaveReport v-else :state="save_state" @exit="emit('exit')" />
  </div>
</template>

<style scoped lang="scss">
.container {
  width: 100%;
  height: 100%;
  position: relative;
  background-color: #0008;
  backdrop-filter: blur(12px) brightness(0.8);
  .content {
    position: absolute;
    top: 4rem;
    left: 0;
    right: 0;
    bottom: 0;
  }
  .done {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2rem;
    font-weight: bold;
  }
}

.meta-container,
.frame-container {
  width: 100%;
  height: 100%;
}
.meta-container {
  overflow-x: hidden;
  overflow-y: scroll;
  padding: 0;
  & > * {
    width: 100%;
    margin: 0;
  }
}
.frame-container {
  padding: 2rem;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: flex-start;
  overflow-x: hidden;
  overflow-y: scroll;
  gap: 2rem;
  & > * {
    width: 20rem;
    height: 15rem;
    margin: 0 1rem;
  }
}
</style>
