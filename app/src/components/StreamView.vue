<script setup lang="ts">
import { Log } from "core";
import { Frame } from "core";
import type { Mat, Size, Point, Rect, Camera } from "core";
import { computed, markRaw, onUnmounted, ref, watch } from "vue";

import { FreqMeter, PerfTimer } from "@lib/util/perf";
import abortable from "@lib/abortable";
import FrameView from "./FrameView.vue";
import { getCameraInfo } from "@lib/camera";

type Stream = Iterable<Frame | Mat<Uint8Array> | null>;

const emit = defineEmits<{
    (e: "mousedown", event: MouseEvent & Point & Size): void;
    (e: "mouseup", event: MouseEvent & Point & Size): void;
    (e: "mousemove", event: MouseEvent & Point & Size): void;
    (e: "mouseleave", event: MouseEvent & Point & Size): void;
    (e: "pointerdown", event: PointerEvent & Point & Size): void;
    (e: "pointerup", event: PointerEvent & Point & Size): void;
    (e: "pointermove", event: PointerEvent & Point & Size): void;
    (e: "pointerleave", event: PointerEvent & Point & Size): void;
}>();

const props = defineProps({
    title: {
        type: String,
        required: false,
        default: null,
    },
    footnote: {
        type: String,
        required: false,
        default: null,
    },
    stream: {
        type: Object as () => Stream | undefined,
        required: false,
        default: undefined,
    },
    camera: {
        type: Object as () => Camera | undefined,
        required: false,
        default: undefined,
    },
    overlay: {
        type: Object as () => Record<string, string>,
        required: false,
        default: {},
    },
    theme: {
        type: String,
        required: false,
        default: "gray",
    },
    width: {
        type: String,
        required: false,
        default: null,
    },
    height: {
        type: String,
        required: false,
        default: null,
    },
    slice: {
        type: Object as () => Rect | null,
        required: false,
        default: null,
    },
});

const mat = ref<Mat<Uint8Array> | null>(null);
const fps = new FreqMeter();
const perf = new PerfTimer();

const stream = computed(() => {
    if (props.stream) return markRaw(props.stream);
    if (props.camera) return markRaw(props.camera.stream);
    return undefined;
});

function createTask(stream?: Stream) {
    if (!stream) return null;
    return abortable(async (aborted) => {
        try {
            for (const frame of stream) {
                if (aborted()) break;
                if (frame) {
                    if (frame instanceof Frame) {
                        mat.value = await perf.measure(async () => {
                            Log.verbose(`Requested: ${frame}.view(${"BGRA8"})`);
                            const m = await frame.view("BGRA8", mat.value);
                            Log.verbose(` Resolved: ${frame}.view(${"BGRA8"})`);
                            return m;
                        });
                        frame.release();
                    } else {
                        mat.value = frame;
                    }
                    fps.tick();
                }
                await new Promise(requestAnimationFrame);
            }
        } catch (e) {
            console.error(e);
        }
    });
}

const task = computed(() => createTask(stream.value));
watch(task, (_, prev) => prev?.abort());
onUnmounted(() => task.value?.abort());

const cameraInfo = computed(() =>
    props.camera ? getCameraInfo(props.camera) : {}
);

const overlay = computed(() => ({
    ...(props.overlay ?? {}),
    ...cameraInfo.value,
    "Frame Rate": fps.toString(),
    "CVT Time": perf.toString(),
}));
</script>

<template>
    <FrameView
        :mat="mat"
        :overlay="overlay"
        :title="title"
        :footnote="footnote"
        :theme="theme"
        :width="width"
        :height="height"
        :slice="slice"
        @mousedown="(e) => emit('mousedown', e)"
        @mouseup="(e) => emit('mouseup', e)"
        @mousemove="(e) => emit('mousemove', e)"
        @mouseleave="(e) => emit('mouseleave', e)"
        @pointerdown="(e) => emit('pointerdown', e)"
        @pointerup="(e) => emit('pointerup', e)"
        @pointermove="(e) => emit('pointermove', e)"
        @pointerleave="(e) => emit('pointerleave', e)"
    >
        <slot></slot>
    </FrameView>
</template>

<style scoped lang="scss">
.container {
    position: relative;
    background-color: black;
    background: repeating-linear-gradient(
        45deg,
        #111,
        #111 10px,
        #222 10px,
        #222 20px
    );
    overflow: visible;
    outline: 2px solid var(--theme, gray);

    .title {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 100%;
        height: 2em;
        line-height: 2em;
        font-size: 0.8em;
        text-align: left;
        color: gray;
        user-select: none;
    }

    .footnote {
        position: absolute;
        left: 0;
        right: 0;
        top: 100%;
        height: 2em;
        line-height: 2em;
        font-size: 0.8em;
        text-align: left;
        color: gray;
        user-select: none;
    }

    &:hover .title {
        color: var(--theme, gray);
    }

    canvas {
        margin: 0;
    }

    .stream-info {
        flex-direction: column;
        justify-content: center;
        align-items: left;
        overflow-y: scroll;
    }

    &.no-stream {
        outline-color: #444 !important;
    }

    .no-stream-text {
        color: #444;
        justify-content: center;
        align-items: center;
        font-size: 2em;
    }

    & > .centered {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
    }

    &:not(:hover) {
        outline: none !important;
    }
}

:deep(.overlay) {
    background-color: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(4px) saturate(50%) brightness(80%);
    -webkit-backdrop-filter: blur(4px) saturate(50%) brightness(80%);
    color: white;
    font-family: "Cascadia Code", "Courier New", Courier, monospace;
    z-index: 10;
    white-space: pre;
}
</style>
