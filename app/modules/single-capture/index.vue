<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import useCameras, { initCamera, useCameraConfig } from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
const cameras = await useCameras();
const camera = ref<string | null>(null);
const stream = computed(() => {
  if (!camera.value) return;
  return cameras.get(camera.value)?.stream;
});
watch(camera, async (id) => {
  if (!id) return;
  const cam = cameras.get(id);
  if (!cam) return;
  const config = await useCameraConfig(cam);
  initCamera(cam, config);
});
onUnmounted(() => {
  cameras.release();
});
</script>

<template>
  <div class="content">
    <StreamView
      class="stream"
      title="Camera View"
      :stream="stream"
      theme="yellow"
    ></StreamView>
    <div class="controls">
      <label>
        Camera
        <select v-model="camera">
          <option :value="null">Select a Camera</option>
          <option v-for="k of cameras.keys()" :key="k" :value="k">
            {{ k }}
          </option>
        </select>
      </label>
    </div>
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
  --size: min(90vw, 120vh);
}
.stream {
  width: var(--size);
  height: calc(var(--size) * 3 / 4);
  margin: 2rem;
}
.controls {
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  gap: 1em;
}
</style>
