<script setup lang="ts">
import { computed, markRaw, ref, watch } from "vue";
import { cameras, updateCameras } from "./store";
import StreamView from "./StreamView.vue";
import type { Camera, Stream } from "core";

const wide_cam = computed(() => cameras.get("22071833") as Camera | undefined);
const fovea_l = computed(() => cameras.get("24044020") as Camera | undefined);
const fovea_r = computed(() => cameras.get("24155467") as Camera | undefined);

function configCamera(camera?: Camera) {
    if (!camera) return;
    camera.exposure_auto = "Off";
    camera.exposure = 16e3; // 60 FPS
    camera.gain_auto = "Off";
    camera.gain = 30;
}

watch(fovea_l, (cam) => configCamera(cam), { immediate: true });
watch(fovea_r, (cam) => configCamera(cam), { immediate: true });

function info(camera?: Camera) {
    return camera && {
        Vendor: camera.vendor ?? "Unknown",
        Camera: camera.model ?? "Unknown",
        Serial: camera.serial ?? "Unknown",
        Exposure: `${(camera.exposure / 1000).toFixed(2)} ms`,
        Gain: `${(camera.gain).toFixed(2)} dB`,
    }
}

function getStream(camera?: Camera) {
    return camera && markRaw(camera.stream);
}

function releaseStream(stream?: Stream) {
    stream?.release();
}

watch(() => getStream(fovea_l.value), (stream, old) => {
    releaseStream(old);
});
watch(() => getStream(fovea_r.value), (stream, old) => {
    releaseStream(old);
});
</script>

<template>
    <div class="cameras">
        <StreamView name="Left Fovea" :stream="getStream(fovea_l)" :overlay="info(fovea_l)"
            style="outline: 2px solid cyan;" />
        <StreamView name="Wide Camera" :stream="getStream(wide_cam)" :overlay="info(wide_cam)"
            style="outline: 2px solid orange;" />
        <StreamView name="Right Fovea" :stream="getStream(fovea_r)" :overlay="info(fovea_r)"
            style="outline: 2px solid greenyellow;" />
    </div>
</template>

<style scoped lang="scss">
.cameras {
    display: flex;
    justify-content: space-evenly;
    flex-wrap: wrap;
    flex-direction: row;
    width: 100%;
    padding: 1vw 0;
    margin: 0;

    &>* {
        width: 32vw;
        height: 24vw;
    }
}
</style>
