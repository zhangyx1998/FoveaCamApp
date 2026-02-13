<script setup lang="ts">
import Capture from ".";
import FrameView from "@src/components/FrameView.vue";
import SaveControls from "./SaveControls.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import { ref } from "vue";
const emit = defineEmits(["exit"]);
const capture = new Capture();
const complete = ref(false);
function finish() {
  complete.value = true;
  setTimeout(() => emit("exit"), 1000);
}
</script>

<template>
  <div class="container">
    <SaveControls
      style="height: 4rem"
      @save="
        (p, f) => {
          capture.save(p, f);
          finish();
        }
      "
      @exit="emit('exit')"
      :disabled="complete"
    />
    <HorizontalDivision class="content" v-if="!complete">
      <template #left>
        <div class="meta-container">
          <div
            class="meta-entry"
            v-for="([name, meta], i) in capture.meta.entries()"
            :key="i"
          >
            <h3>{{ name }}</h3>
            <pre>{{ JSON.stringify(meta, null, 2) }}</pre>
          </div>
        </div>
      </template>
      <template #right>
        <div class="frame-container">
          <template
            class="frame-entry"
            v-for="([name, images], i) in capture.image.entries()"
            :key="i"
          >
            <template v-if="Array.isArray(images)">
              <FrameView
                class="frame"
                v-for="(f, j) in images"
                :key="j"
                :mat="f"
                :title="name"
              ></FrameView>
            </template>
            <template v-else>
              <FrameView class="frame" :mat="images" :title="name"></FrameView>
            </template>
          </template>
        </div>
      </template>
    </HorizontalDivision>
    <div class="content done" v-else>Assets Saved</div>
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
  padding: 2rem;
}
.meta-container {
  overflow-x: hidden;
  overflow-y: scroll;
}
.frame-container {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-start;
  align-items: flex-start;
  overflow-x: hidden;
  overflow-y: scroll;
  gap: 2rem;
}
.frame {
  width: 20rem;
  height: 15rem;
  margin: 0 1rem;
}
</style>
