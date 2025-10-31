<script setup lang="ts">
import abortable from "@lib/abortable";
import useCameras, { describeCamera, getCameraInfo } from "@lib/camera";
import { delay } from "@lib/util";
import { FreqMeter } from "@lib/util/perf";
import StreamView from "@src/components/StreamView.vue";
import { ArUcoDetector, type Frame } from "core";
import { computed, markRaw, onUnmounted, ref, watch } from "vue";
const cameras = await useCameras();

const observer = ref<"NONE" | "SYNC" | "ASYNC">("NONE");
const fps = new FreqMeter();

const cam = cameras.values().next().value;
const stream = cam && cam.stream;

const detector = new ArUcoDetector("4X4_50");

async function workload(frame: Frame) {
    const result = await detector.detect(frame);
    console.log(result);
    frame.release();
}

const task = computed(() => {
    if (!stream) return;
    switch (observer.value) {
        case "SYNC":
            return abortable(async (aborted) => {
                try {
                    for (const frame of stream) {
                        if (aborted()) break;
                        if (!frame) {
                            await delay(1);
                            continue;
                        } else {
                            fps.tick();
                            console.log(await workload(frame));
                            frame.release();
                        }
                    }
                } finally {
                    fps.reset();
                }
            });
        case "ASYNC":
            return abortable(async (aborted) => {
                try {
                    for await (const frame of stream) {
                        if (aborted()) break;
                        fps.tick();
                        console.log(await workload(frame!));
                        frame!.release();
                    }
                } finally {
                    fps.reset();
                }
            });
        case "NONE":
        default:
            return undefined;
    }
});

watch(task, (_, prev) => prev?.abort());

onUnmounted(async () => {
    await task.value?.abort();
    cameras.release();
});
</script>

<template>
    <div class="playground">
        <StreamView
            :title="describeCamera(cam)"
            :stream="stream && markRaw(stream)"
            :overlay="getCameraInfo(cam)"
            :footnote="task ? 'FPS: ' + fps.toString() : '(Observer inactive)'"
            theme="white"
            width="min(50vw, 100vh)"
        ></StreamView>
        <label>
            Observer thread type:
            <select v-model="observer">
                <option value="NONE">None</option>
                <option value="SYNC">Synchronous</option>
                <option value="ASYNC">Asynchronous</option>
            </select>
        </label>
    </div>
</template>

<style lang="scss" scoped>
.playground {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
}
</style>
