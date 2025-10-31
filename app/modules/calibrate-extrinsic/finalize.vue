<script setup lang="ts">
import FrameView from "@src/components/FrameView.vue";
import { ExtrinsicRecord } from "./calibrate";
import { ROLE, THEME } from "@lib/camera";
import Marker from "./Marker.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import type { Point2d, Undistort } from "core";
import NavBack from "@src/components/NavBack.vue";

const props = defineProps<{
    undistort: Undistort;
    records: ExtrinsicRecord[];
    finalized: boolean;
    saved: boolean;
}>();

const emit = defineEmits<{
    (e: "back"): void;
    (e: "preview"): void;
    (e: "confirm"): void;
}>();

function cursor(angle: Point2d) {
    return {
        ...props.undistort.position([angle], true)[0],
        ...props.undistort.sensor_size,
    };
}
</script>

<template>
    <div class="finalize" style="padding-top: 4em">
        <template v-for="({ L, C, R }, i) in records" :key="i">
            <div class="divider" v-if="i > 0"></div>
            <div class="record">
                <FrameView
                    width="30%"
                    :title="ROLE.L"
                    :mat="L.frame"
                    :theme="THEME.L"
                >
                    <Marker
                        :detection="L.img_points"
                        :features="L.img_points"
                        :color="THEME.L"
                    />
                </FrameView>
                <FrameView
                    width="30%"
                    :title="ROLE.C"
                    :mat="C.frame"
                    :theme="THEME.C"
                >
                    <Marker
                        :detection="C.img_points"
                        :features="C.img_points"
                        :color="THEME.C"
                    />
                    <FrameCursor
                        :cursor="cursor(C.angle)"
                        :undistort="undistort"
                        box="rect"
                    />
                </FrameView>
                <FrameView
                    width="30%"
                    :title="ROLE.R"
                    :mat="R.frame"
                    :theme="THEME.R"
                >
                    <Marker
                        :detection="R.img_points"
                        :features="R.img_points"
                        :color="THEME.R"
                    />
                </FrameView>
            </div>
        </template>
        <NavBack @click="emit('back')">
            <span>Back to Calibration</span>
            <div style="flex-grow: 1"></div>
            <button :disabled="!finalized" @click="emit('preview')">
                Preview Results
            </button>
            <button :disabled="!finalized || saved" @click="emit('confirm')">
                Confirm and Save
            </button>
        </NavBack>
    </div>
</template>

<style scoped lang="scss">
.finalize {
    width: 100%;
    max-height: 100%;
    overflow-y: scroll;
    display: flex;
    flex-direction: column;
    overflow: auto;
    align-items: stretch;
    padding: 2em;
    gap: 2em;
    box-sizing: border-box;
    .record {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-evenly;
        flex-grow: 1;
    }
    .divider {
        width: 100%;
        height: 5px;
        background-color: #f00;
    }
}
</style>
