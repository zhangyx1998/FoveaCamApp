<script setup lang="ts">
import { computed, markRaw, onUnmounted, watch } from "vue";
import type { Camera } from "core";
import { ArUcoDetector } from "core";

import useCameras from "@lib/camera-store";
import StreamView from "@src/components/StreamView.vue";
import ArUcoDetection from "@src/components/ArUcoDetection.vue";
import PosView from "@src/components/PosView.vue";
import { getController, Pos } from "@src/components/Controller.vue";
import { info } from "@lib/camera-config";
import Tracker, { actuate } from "./tracker";

const cameras = await useCameras();

const cam = {
    l: cameras.get("24044020"),
    c: cameras.get("22071833"),
    r: cameras.get("24155467"),
};

function configCamera(camera: Camera | undefined, gain: number) {
    if (!camera) return;
    camera.frame_rate_enable = false;
    camera.exposure_auto = "Off";
    camera.exposure = 16e3; // 60 FPS
    camera.gain_auto = "Off";
    camera.gain = gain;
}

configCamera(cam.l, 30);
configCamera(cam.c, 0);
configCamera(cam.r, 30);

function getStream(camera?: Camera) {
    return camera && markRaw(camera.stream);
}

const detector = new ArUcoDetector("4X4_100");

const tracker = {
    l: cam.l && new Tracker(cam.l, detector, 1, 0.25),
    c: cam.c && new Tracker(cam.c, detector, 0, 0.5),
    r: cam.r && new Tracker(cam.r, detector, 2, 0.25),
};

const controller = computed(getController);
const actuator = computed(
    () => controller.value && actuate(controller.value, tracker.l, tracker.r)
);
watch(actuator, (_, prev) => prev?.abort());

function formatPos(pos?: Pos) {
    return pos
        ? `X ${pos.x.toFixed(2)}, Y ${pos.y.toFixed(2)}`
        : "X: --.--, Y: --.--";
}

onUnmounted(async () => {
    await Promise.all([
        tracker.l?.task.abort(),
        tracker.c?.task.abort(),
        tracker.r?.task.abort(),
        actuator.value?.abort(),
    ]);
    cameras.release();
});
</script>

<template>
    <div class="cameras">
        <div class="view">
            <StreamView
                class="stream"
                :name="`Left Fovea | ${formatPos(controller?.pos.left)}`"
                :footnote="`ArUco Tracker @ ${tracker.l?.fps ?? 'N/A'} Hz`"
                :stream="getStream(cam.l)"
                :overlay="info(cam.l)"
                theme="cyan"
            >
                <ArUcoDetection
                    v-if="tracker.l?.target"
                    :detection="tracker.l.target"
                />
                <ArUcoDetection
                    v-for="(d, i) in tracker.l?.other_targets"
                    :key="i"
                    :detection="d"
                    color="gray"
                />
            </StreamView>
            <div class="config-entry" v-if="tracker.l">
                <span>ArUco ID to Track:</span>
                <input v-model.number="tracker.l.target_id" />
            </div>
            <PosView
                v-if="controller"
                :pos="controller.pos.left"
                :lim="controller.dv"
                color="cyan"
                style="width: 100%"
            />
        </div>
        <div class="view">
            <StreamView
                class="stream"
                name="Wide Camera"
                :footnote="`ArUco Tracker @ ${tracker.c?.fps ?? 'N/A'} Hz`"
                :stream="getStream(cam.c)"
                :overlay="info(cam.c)"
                theme="orange"
            >
                <ArUcoDetection
                    v-if="tracker.c?.target"
                    :detection="tracker.c.target"
                />
                <ArUcoDetection
                    v-for="(d, i) in tracker.c?.other_targets"
                    :key="i"
                    :detection="d"
                    color="gray"
                />
            </StreamView>
            <div class="config-entry" v-if="tracker.c">
                <span>ArUco ID to Track:</span>
                <input v-model.number="tracker.c.target_id" />
            </div>
        </div>
        <div class="view">
            <StreamView
                class="stream"
                :name="`Right Fovea | ${formatPos(controller?.pos.right)}`"
                :footnote="`ArUco Tracker @ ${tracker.r?.fps ?? 'N/A'} Hz`"
                :stream="getStream(cam.r)"
                :overlay="info(cam.r)"
                theme="greenyellow"
            >
                <ArUcoDetection
                    v-if="tracker.r?.target"
                    :detection="tracker.r.target"
                />
                <ArUcoDetection
                    v-for="(d, i) in tracker.r?.other_targets"
                    :key="i"
                    :detection="d"
                    color="gray"
                />
            </StreamView>
            <div class="config-entry" v-if="tracker.r">
                <span>ArUco ID to Track:</span>
                <input v-model.number="tracker.r.target_id" />
            </div>
            <PosView
                v-if="controller"
                :pos="controller.pos.right"
                :lim="controller.dv"
                color="greenyellow"
                style="width: 100%"
            />
        </div>
    </div>
</template>

<style scoped lang="scss">
.cameras {
    display: flex;
    justify-content: space-evenly;
    flex-wrap: wrap;
    flex-direction: row;
    width: 100%;
    padding: 0.5em 0;
    margin: 0;

    & > * {
        width: 30vw;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
    }

    .stream {
        width: 30vw;
        height: 22.5vw;
    }
}

.config-entry {
    padding-left: 1ch;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid transparent;

    & > * {
        text-wrap: nowrap;
    }

    &:hover {
        border-bottom: 1.5px solid #fff4;
    }

    &:focus-within {
        border-bottom: 1.5px solid #fff8;
    }

    margin: 0.4em 0;

    input {
        width: 2ch;
        text-align: center;
        background: none;
        border: 1.5px solid transparent;
        color: #ccc;
        outline: none !important;
        font-size: inherit;
        font-family: inherit;
    }
}
</style>
