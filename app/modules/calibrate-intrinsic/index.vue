<script setup lang="ts">
import {
    computed,
    markRaw,
    onUnmounted,
    ref,
    shallowReactive,
    shallowRef,
    toRaw,
    watch,
} from "vue";
import {
    Mat,
    type Size,
    Vision,
    type Point,
    type Point3d,
    type CameraCalibration,
} from "core";

import { getCameraKey, useMatchedCameras } from "@lib/camera-store";
import StreamView from "@src/components/StreamView.vue";
import { info } from "@lib/camera-config";
import abortable from "@lib/abortable";
import { FreqMeter } from "@lib/util/perf";
import { delay } from "@lib/util";
import CheckerDetection from "./CheckerDetection.vue";
import FrameView from "@src/components/FrameView.vue";
import Store from "@lib/store";
import FrameCursor from "@src/components/FrameCursor.vue";
import { deg } from "@lib/util/math";
import { useIntrinsicCalibration } from "@lib/camera-calibration";

const cameras = await useMatchedCameras();
const camera = cameras.C;
const stream = camera && markRaw(camera.stream);
const { calibration, undistort } = await useIntrinsicCalibration(camera);

const cursor = shallowRef<(Point & Size) | null>(null);

type Record = {
    rgba: Mat<Uint8Array>;
    gray: Mat<Uint8Array>;
    img_points: Point[];
    obj_points: Point3d[];
};

function validateCalibration(
    cal?: Partial<CameraCalibration>
): cal is CameraCalibration {
    return Boolean(
        cal &&
            cal.sensor_size &&
            cal.camera_matrix &&
            cal.dist_coeffs &&
            cal.rvecs &&
            cal.tvecs
    );
}

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
    if (calibration) Object.assign(calibration, result, { date: new Date() });
    console.log("Calibration Result:", result);
}

onUnmounted(async () => {
    await task?.abort();
    cameras?.release();
    clearRecords();
});
</script>

<template>
    <div class="view">
        <div class="left" style="flex-grow: 1">
            <StreamView
                class="stream"
                name="Wide Angle Camera"
                :footnote="`Chess Board  Detector @ ${freq}`"
                :stream="stream"
                :overlay="info(camera)"
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
            <div class="config-entry">
                Pattern Size: W
                <input v-model.number="pattern_size.width" />
                × H
                <input v-model.number="pattern_size.height" />
                -> {{ detection?.img_points.length ?? 0 }} corners
            </div>
            <div class="config-entry" v-if="calibration?.date">
                Calibrated At&nbsp;
                <span>{{ new Date(calibration.date).toLocaleString() }}</span>
            </div>
            <div class="config-entry" v-if="undistort?.fov">
                FOV: X {{ deg(undistort.fov.x).toFixed(2) }} degrees, Y
                {{ deg(undistort.fov.y).toFixed(2) }} degrees
            </div>
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

.config-entry {
    font-size: 1.2em;
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
