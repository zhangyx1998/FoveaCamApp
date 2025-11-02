<script setup lang="ts">
import { markRaw, onUnmounted, shallowReactive, shallowRef, watch } from "vue";
import {
    Vision,
    type Mat,
    type Size,
    type Point,
    type Point3d,
    type Camera,
    type Undistort,
    type CameraCalibration,
} from "core";
import StreamView from "@src/components/StreamView.vue";
import abortable from "@lib/abortable";
import { FreqMeter } from "@lib/util/perf";
import { delay } from "@lib/util";
import CheckerDetection from "./CheckerDetection.vue";
import FrameView from "@src/components/FrameView.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import { deg } from "@lib/util/math";
import { describeCamera, type CameraConfig } from "@lib/camera";
import NavBack from "@src/components/NavBack.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import CameraRole from "@src/components/CameraRole.vue";

const props = defineProps<{
    camera: Camera;
    config: CameraConfig;
    calibration: Partial<CameraCalibration>;
    undistort?: Undistort;
}>();

const emit = defineEmits<{
    (e: "return"): void;
}>();

const { camera, calibration } = props;
const stream = markRaw(camera.stream);

const cursor = shallowRef<(Point & Size) | null>(null);

type Record = {
    rgba: Mat<Uint8Array>;
    gray: Mat<Uint8Array>;
    img_points: Point[];
    obj_points: Point3d[];
};

const freq = new FreqMeter();
const pattern_size = shallowReactive({ width: 6, height: 6 });
const sensor_size = shallowReactive<Size>({ width: 0, height: 0 });
const detection = shallowRef<Record | null>(null);
const records = shallowReactive<Array<Record>>([]);

function clearRecords() {
    while (records.length > 0) records.pop();
}

function removeRecord(index: number) {
    records.splice(index, 1);
}

watch(sensor_size, (a, b) => {
    if (a.width !== b.width || a.height !== b.height) clearRecords();
});
watch(pattern_size, clearRecords);

function objPoints(size: number = 1.0) {
    const ret: Point3d[] = [];
    const { width, height } = pattern_size;
    const dx = (width - 1) * size * 0.5;
    const dy = (height - 1) * size * 0.5;
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
            ret.push({ x: x * size - dx, y: y * size - dy, z: 0 });
    return ret;
}

const task = abortable(async (aborted) => {
    if (!stream) return;
    for (const frame of stream) {
        if (aborted()) break;
        if (frame === null) {
            await delay(1);
            continue;
        }
        freq.tick();
        sensor_size.width = frame.width;
        sensor_size.height = frame.height;
        const [rgba, gray, corners] = await Promise.all([
            frame.view("BGRA8"),
            frame.view("Mono8"),
            Vision.findChessboardCorners(
                await frame.view("Mono8"),
                pattern_size
            ),
        ]);
        detection.value =
            corners.length > 0
                ? {
                      rgba,
                      gray,
                      img_points: corners,
                      obj_points: objPoints(),
                  }
                : null;
        frame.release();
    }
});

function capture() {
    if (detection.value) {
        records.push(detection.value);
        detection.value = null;
    }
}

async function calibrate() {
    const img_points = await Promise.all(
        records.map((r) => Vision.cornerSubPix(r.gray, r.img_points))
    );
    const obj_points = records.map((r) => r.obj_points);
    const result = await Vision.calibrateCamera(
        sensor_size,
        img_points,
        obj_points
    );
    Object.assign(calibration, result, { date: new Date() });
    console.log("Calibration Result:", result);
}

onUnmounted(async () => {
    await task?.abort();
    clearRecords();
});
</script>

<template>
    <div class="view">
        <div class="left" style="flex-grow: 1; padding-top: 3em;">
            <NavBack @back="emit('return')">
                <span>{{ describeCamera(camera) }}</span>
                <CameraRole v-if="config.role" :role="config.role" />
            </NavBack>
            <StreamView
                class="stream"
                :footnote="`Chess Board  Detector @ ${freq}`"
                :camera="camera"
                height="min(60vh, 80vw)"
                @mousemove="(e) => (cursor = e)"
                @mouseleave="() => (cursor = null)"
            >
                <CheckerDetection
                    v-if="detection"
                    :detection="detection.img_points"
                />
                <FrameCursor
                    :cursor="cursor"
                    :undistort="undistort"
                    box="dot"
                />
            </StreamView>
            <ConfigEntry>
                Pattern Size: W
                <input v-model.number="pattern_size.width" style="width: 2ch" />
                × H
                <input
                    v-model.number="pattern_size.height"
                    style="width: 2ch"
                />
                -> {{ detection?.img_points.length ?? 0 }} corners
            </ConfigEntry>
            <ConfigEntry v-if="calibration.date">
                Calibrated At&nbsp;
                <span>{{ calibration.date.toLocaleString() }}</span>
            </ConfigEntry>
            <ConfigEntry v-if="undistort?.fov">
                FOV: X {{ deg(undistort.fov.x).toFixed(2) }}&deg;, Y
                {{ deg(undistort.fov.y).toFixed(2) }}&deg;
            </ConfigEntry>
        </div>
        <div class="right">
            <div class="records">
                <div
                    v-for="(record, i) in records"
                    class="record"
                    :key="i"
                    @click="removeRecord(i)"
                >
                    <FrameView :mat="record.rgba" width="100%">
                        <CheckerDetection :detection="record.img_points" />
                    </FrameView>
                </div>
            </div>
            <h2>Captured Records ({{ records.length }})</h2>
            <div class="buttons">
                <button @click="capture" :disabled="!detection">Capture</button>
                <button @click="calibrate" :disabled="!records.length">
                    Calibrate
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.view {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: row;
    .left,
    .right {
        display: flex;
        flex-direction: column;
    }
    .left {
        justify-content: center;
        align-items: center;
        background-color: #111;
    }
    .right {
        border-left: 2px solid #333;
        background-color: #222;
        width: max(30vw, 20ch);
        position: relative;
        box-sizing: border-box;
        .record {
            width: calc(50% - 0.55rem);
        }
        h2,
        .buttons,
        .records {
            position: absolute;
            left: 0;
            right: 0;
            padding: 0 1rem;
            margin: 0;
            background-color: #222a;
            box-sizing: border-box;
        }
        h2 {
            top: 0;
            height: 3rem;
            line-height: 3rem;
            font-size: 1.4rem;
        }
        .records {
            top: 0;
            bottom: 0;
            display: flex;
            flex-direction: row;
            overflow-y: scroll;
            flex-wrap: wrap;
            gap: 1rem;
            justify-content: flex-start;
            align-items: flex-start;
            align-content: flex-start;
            padding: 3rem 1rem;
        }
        .buttons {
            left: 0;
            right: 0;
            bottom: 0;
            height: 3rem;
            box-sizing: border-box;
            padding: 0 1rem;
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
    }
}
</style>
