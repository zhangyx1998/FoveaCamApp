<script setup lang="ts">
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faCamera } from "@fortawesome/free-solid-svg-icons";
import { computed, onUnmounted, ref } from "vue";
import FrameView from "@src/components/FrameView.vue";
import { Mat } from "core/Vision";
import useCameras from "@lib/camera";
const mat = ref<Mat<Uint8Array> | null>(null);
const busy = ref(false);
const cameras = await useCameras();
const camera = ref<string | null>(null);
async function capture() {
  busy.value = true;
  if (camera.value === null) return;
  try {
    const c = cameras.get(camera.value);
    if (!c) return;
    const frame = await c.grab();
    mat.value = await frame.view("BGRA8");
    frame.release();
  } catch (e) {
    console.error(e);
  } finally {
    busy.value = false;
  }
}
onUnmounted(() => {
  cameras.release();
});
</script>

<template>
  <div class="content">
    <FrameView
      class="stream"
      title="Captured Frame"
      :mat="mat"
      theme="lime"
    ></FrameView>
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
      <button @click="capture" :disabled="busy">
        <Icon :icon="faCamera" /> Capture
      </button>
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
  --size: min(90vw, 100vh);
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
