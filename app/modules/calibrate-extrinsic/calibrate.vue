<script setup lang="ts">
import { computed, markRaw, onUnmounted, reactive, watch } from "vue";
import type { Camera } from "core";
import { ArUcoDetector } from "core";

import { useMatchedCameras } from "@lib/camera-store";
import StreamView from "@src/components/StreamView.vue";
import ArUcoDetection from "./ArUcoDetection.vue";
import PosView from "@src/components/PosView.vue";
import { getController, Pos } from "@src/components/Controller.vue";
import { info } from "@lib/camera-config";
import Tracker, { actuate } from "./tracker";
import { useIntrinsicCalibration } from "@lib/camera-calibration";
import FrameCursor from "@src/components/FrameCursor.vue";
import { ExtrinsicRecord } from "./record";

const emit = defineEmits<{
    (e: "finalize", records: ExtrinsicRecord[]): void;
}>();
const cam = await useMatchedCameras();

const { undistort } = await useIntrinsicCalibration(cam.C);

function getStream(camera?: Camera) {
    return camera && markRaw(camera.stream);
}

const detector = new ArUcoDetector("4X4_50");

const tracker = {
    L: cam.L && new Tracker(cam.L, detector, 1, 0.25),
    C: cam.C && new Tracker(cam.C, detector, 0, 0.5),
    R: cam.R && new Tracker(cam.R, detector, 2, 0.25),
};

const controller = computed(getController);
const actuator = computed(
    () => controller.value && actuate(controller.value, tracker.L, tracker.R)
);
watch(actuator, (_, prev) => prev?.abort());

const recordable = computed(() => {
    return (
        controller.value &&
        [tracker.L, tracker.C, tracker.R].every((t) => t?.isRecordable)
    );
});

const records = reactive([]) as ExtrinsicRecord[];

async function appendToRecord() {
    if (!recordable.value) return;
    const { pos } = controller.value!;
    records.push({
        L: await tracker.L!.record({ pos: pos.left }),
        C: await tracker.C!.record(),
        R: await tracker.R!.record({ pos: pos.right }),
    } as ExtrinsicRecord);
}

onUnmounted(async () => {
    await Promise.all([
        tracker.L?.task.abort(),
        tracker.C?.task.abort(),
        tracker.R?.task.abort(),
        actuator.value?.abort(),
    ]);
    cam.release();
});
</script>

<template>
    <div class="cameras">
        <div class="view">
            <StreamView
                class="stream"
                name="Left Fovea"
                :footnote="`ArUco Tracker @ ${tracker.L?.fps ?? 'N/A'}`"
                :stream="getStream(cam.L)"
                :overlay="info(cam.L)"
                theme="cyan"
            >
                <ArUcoDetection
                    v-if="tracker.L?.target"
                    :detection="tracker.L.target"
                />
                <ArUcoDetection
                    v-for="(d, i) in tracker.L?.other_targets"
                    :key="i"
                    :detection="d"
                    color="gray"
                />
            </StreamView>
            <div class="config-entry" v-if="tracker.L">
                <span>
                    {{ tracker.L?.target ? "✓" : "✗" }}
                    ArUco ID to Track:
                </span>
                <input v-model.number="tracker.L.target_id" />
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
                :footnote="`ArUco Tracker @ ${tracker.C?.fps ?? 'N/A'}`"
                :stream="getStream(cam.C)"
                :overlay="info(cam.C)"
                theme="orange"
            >
                <ArUcoDetection
                    v-if="tracker.C?.target"
                    :detection="tracker.C.target"
                />
                <ArUcoDetection
                    v-for="(d, i) in tracker.C?.other_targets"
                    :key="i"
                    :detection="d"
                    color="gray"
                />
                <FrameCursor
                    v-if="tracker.C?.center_absolute"
                    :cursor="tracker.C.center_absolute"
                    :undistort="undistort"
                    box="rect"
                />
            </StreamView>
            <div class="config-entry" v-if="tracker.C">
                <span>
                    {{ tracker.C?.target ? "✓" : "✗" }}
                    ArUco ID to Track:
                </span>
                <input v-model.number="tracker.C.target_id" />
            </div>
            <div class="actions">
                <button :disabled="!recordable" @click="appendToRecord">
                    Record ({{ records.length }})
                </button>
                <button
                    :disabled="records.length === 0"
                    @click="emit('finalize', records)"
                >
                    Finalize Calibration
                </button>
            </div>
        </div>
        <div class="view">
            <StreamView
                class="stream"
                name="Right Fovea"
                :footnote="`ArUco Tracker @ ${tracker.R?.fps ?? 'N/A'}`"
                :stream="getStream(cam.R)"
                :overlay="info(cam.R)"
                theme="greenyellow"
            >
                <ArUcoDetection
                    v-if="tracker.R?.target"
                    :detection="tracker.R.target"
                />
                <ArUcoDetection
                    v-for="(d, i) in tracker.R?.other_targets"
                    :key="i"
                    :detection="d"
                    color="gray"
                />
            </StreamView>
            <div class="config-entry" v-if="tracker.R">
                <span>
                    {{ tracker.R?.target ? "✓" : "✗" }}
                    ArUco ID to Track:
                </span>
                <input v-model.number="tracker.R.target_id" />
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

.actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 1rem;
    width: 100%;
    & > * {
        display: block;
        width: 0;
        flex-grow: 1;
        height: 2rem;
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
