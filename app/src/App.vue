<script setup lang="ts">
import { computed, markRaw, ref } from "vue";
import { cameras } from "./store";
import StreamView from "./StreamView.vue";
import type { Camera } from "core";
console.log(...cameras);

function getStream(camera: Camera | undefined) {
    if (!camera) return undefined;
    return markRaw(camera.start());
}

const fovea_l = computed(() => cameras.get("24155467") as Camera);
const fovea_r = computed(() => cameras.get("24044020") as Camera);

for (const camera of cameras.values()) {
    camera.exposure_auto = "Off";
    camera.exposure = 16e3; // 60 FPS
    camera.gain_auto = "Off";
    camera.gain = 30;
}
</script>

<template>
    <div style="width: 100%; display: flex; justify-content: center; margin: 1em 0;">
        <h1>Hello from FoveaCam Duo</h1>
    </div>
    <div class="cameras">
        <StreamView :camera="fovea_l" :stream="getStream(fovea_l)"
            style="width: 40vw; height: 30vw; outline: 2px solid cyan;" />
        <StreamView :camera="fovea_r" :stream="getStream(fovea_r)"
            style="width: 40vw; height: 30vw; outline: 2px solid greenyellow;" />
    </div>
</template>

<style scoped>
.cameras {
    display: flex;
    justify-content: space-evenly;
    flex-wrap: wrap;
    flex-direction: row;
}
</style>
