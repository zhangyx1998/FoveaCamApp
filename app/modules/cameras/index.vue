<script setup lang="ts">
import { markRaw, onUnmounted } from "vue";

import useCameras from "@lib/camera-store";
import CameraConfig from "./CameraConfig.vue";

const cameras = await useCameras();

onUnmounted(() => {
    cameras.release();
});
</script>

<template>
    <div class="cameras">
        <CameraConfig
            v-for="camera in cameras.values()"
            :camera="markRaw(camera)"
            style="width: 30vw"
        />
    </div>
</template>

<style scoped lang="scss">
.cameras {
    display: flex;
    justify-content: center;
    flex-wrap: nowrap;
    flex-direction: row;
    width: 100%;
    padding: 0.5em 0;
    margin: 0;
    overflow-y: scroll;
    gap: 2.5vw;
}
</style>
