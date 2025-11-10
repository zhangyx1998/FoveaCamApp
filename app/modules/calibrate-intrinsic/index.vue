<script setup lang="ts">
import { onUnmounted, ref, shallowReactive, shallowRef } from "vue";
import type { Camera } from "core/Aravis";
import useCameras, {
    useCameraConfig,
    useIntrinsicCalibration,
} from "@lib/camera";
import CameraRole from "@src/components/CameraRole.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import CalibrateChecker from "./calibrate-checker.vue";
import CalibrateMarker from "./calibrate-marker.vue";
import { deg } from "@lib/util/math";
import Badge from "@src/components/Badge.vue";

const cameras = await useCameras();

async function getItem(camera: Camera) {
    const [config, intrinsic] = await Promise.all([
        useCameraConfig(camera),
        useIntrinsicCalibration(camera),
    ]);
    return {
        camera,
        config,
        calibration: intrinsic.calibration!,
        get undistort() {
            return intrinsic.undistort;
        },
    };
}
type Item = Awaited<ReturnType<typeof getItem>>;
const items = shallowReactive([]) as Item[];
// State indicator
const calibrating = shallowRef<Item | null>(null);
const method = ref<"CHECKER" | "MARKER">("CHECKER");
// Resolve intrinsic calibration for all cameras
for (const cam of cameras.values())
    getItem(cam).then((item) => items.push(item));

function reset(calibration: Record<string, any>) {
    for (const key in calibration) delete calibration[key];
}

function calibrate(item: Item, m: "CHECKER" | "MARKER") {
    method.value = m;
    calibrating.value = item;
}

onUnmounted(async () => {
    cameras?.release();
});
</script>

<template>
    <div v-if="!calibrating" class="items">
        <h1 style="margin: 0; padding: 0">Select a camera to calibrate</h1>
        <template v-for="(item, i) in items" :key="i">
            <div class="divider"></div>
            <div class="list-item">
                <div class="info">
                    <h3 style="margin: 0; padding: 0">
                        <span style="font-weight: bold; margin-right: 1.5ch">
                            {{ item.camera.vendor }}
                        </span>
                        <span style="font-weight: normal; font-style: italic">
                            {{ item.camera.model }}
                        </span>
                    </h3>
                    <div style="display: flex; gap: 1em; margin: 1em 0">
                        <Badge color="#aaa"
                            >Serial {{ item.camera.serial }}</Badge
                        >
                        <CameraRole
                            v-if="item.config.role"
                            :role="item.config.role"
                        />
                    </div>
                    <template v-if="item.undistort">
                        <ConfigEntry style="color: white">
                            Calibrated @
                            {{
                                item.calibration.date?.toLocaleString() ?? "N/A"
                            }}
                        </ConfigEntry>
                        <ConfigEntry style="color: white" v-if="item.undistort">
                            FOV: X
                            {{ deg(item.undistort.fov.x).toFixed(2) }}&deg;, Y
                            {{ deg(item.undistort.fov.y).toFixed(2) }}&deg;
                        </ConfigEntry>
                    </template>
                    <template v-else>
                        <ConfigEntry
                            style="
                                color: gray;
                                flex-grow: 1;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            "
                        >
                            Camera not calibrated.
                        </ConfigEntry>
                    </template>
                </div>
                <div class="actions">
                    <button
                        @click="calibrate(item, 'CHECKER')"
                        style="--theme: #06a"
                    >
                        Calibrate (Checker)
                    </button>
                    <button
                        @click="calibrate(item, 'MARKER')"
                        style="--theme: #084"
                    >
                        Calibrate (Marker)
                    </button>
                    <button
                        :disabled="!item.calibration.date"
                        @click="reset(item.calibration)"
                        style="--theme: #a00"
                    >
                        Reset
                    </button>
                </div>
            </div>
        </template>
    </div>
    <CalibrateChecker
        v-else-if="method === 'CHECKER'"
        :camera="calibrating.camera"
        :config="calibrating.config"
        :calibration="calibrating.calibration"
        :undistort="calibrating.undistort"
        @return="calibrating = null"
    />
    <CalibrateMarker
        v-else
        :camera="calibrating.camera"
        :config="calibrating.config"
        :calibration="calibrating.calibration"
        :undistort="calibrating.undistort"
        @return="calibrating = null"
    />
</template>

<style scoped lang="scss">
.items {
    position: absolute;
    top: 0;
    left: 50%;
    max-height: 100%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-content: flex-start;
    align-items: stretch;
    flex-wrap: nowrap;
    overflow-y: scroll;
    gap: 1em;
    padding: 2em;
}
.divider {
    height: 1px;
    background-color: #333;
    margin: 1em 0;
}
.list-item {
    height: 100%;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    gap: 2em;
    padding: 1.5em;
    outline: 1px solid #666;
    border-radius: 1em;
    &:hover {
        outline-color: #08c;
        background-color: #fff1;
    }
}
.info {
    flex-grow: 1;
}
.actions {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 0.5em;
    align-items: stretch;
    button {
        --theme: #08c;
        display: block;
        // font-size: inherit;
        // font-family: inherit;
        padding: 0.5em 1em;
        border-radius: 0.5em;
        &:not(:disabled) {
            cursor: pointer;
            background-color: var(--theme);
            color: white;
            border: 1px solid transparent;
            &:hover {
                filter: brightness(1.2);
            }
        }
        &:disabled {
            background-color: transparent;
            color: #666;
            border: 1px solid #666;
            cursor: not-allowed;
        }
    }
}
</style>
