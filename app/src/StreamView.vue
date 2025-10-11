<script setup lang="ts">
import { type Camera, type Stream } from 'core';
import { computed, onUnmounted, ref, shallowRef, useTemplateRef, watch } from 'vue';

import { ElementSize } from '@lib/util/dom';
import Overlay from './components/Overlay.vue';

const props = defineProps({
    name: {
        type: String,
        required: false,
        default: null
    },
    stream: {
        type: Object as () => Stream | undefined,
        required: false,
        default: undefined
    },
    overlay: {
        type: Object as () => Boolean | Record<string, string>,
        required: false,
        default: true
    },
});
const container = useTemplateRef<HTMLDivElement>("container");
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const size = new ElementSize(container);
const controller = new AbortController();

onUnmounted(() => controller.abort());

const fps = ref(0);
const image = shallowRef<ImageData | null>(null);
let t0: number | null = null;
let dt: number | null = null;

function updateFPS(t1: number, decay = 0.95) {
    if (t0 !== null) {
        const delta = t1 - t0;
        dt = dt === null ? delta : dt * decay + delta * (1 - decay);
        fps.value = Math.round(1000 / dt);
    }
    t0 = t1;
}

const canvasStyle = computed(() => {
    if (!image.value) return {};
    const { width: w0, height: h0 } = size;
    const { width: w1, height: h1 } = image.value;
    if (!(w0 && h0 && w1 && h1)) return {};
    const ratio = Math.min(w0 / w1, h0 / h1);
    return {
        width: `${w1 * ratio}px`,
        height: `${h1 * ratio}px`,
    };
});

function render(canvas: HTMLCanvasElement, image: ImageData) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(image, 0, 0);
}

watch(canvas, (c) => {
    if (!c || !image.value) return;
    render(c, image.value);
}, { immediate: true });

watch(() => props.stream, async (stream, prev) => {
    if (!stream) return;
    if (stream.id === prev?.id) return;
    try {
        for (const frame of stream) {
            if (controller.signal.aborted) break;
            if (props.stream?.id !== stream.id) break;
            if (!frame) { await new Promise(requestAnimationFrame); continue; }
            if (!image.value) image.value = new ImageData(
                new Uint8ClampedArray(await frame.view("BGRA8")),
                frame.width,
                frame.height
            )
            else await frame.view("BGRA8", image.value.data);
            frame.release();
            if (canvas.value)
                render(canvas.value, image.value);
            updateFPS(Date.now());
            await new Promise(requestAnimationFrame);
        }
    } catch (e) {
        console.error(e);
    }
}, { immediate: true });

function info() {
    const ret: Record<string, string> = {};
    if (typeof props.overlay === "object")
        Object.assign(ret, props.overlay);
    if (image.value)
        ret["Size"] = `${image.value.width} x ${image.value.height}`;
    ret["FPS"] = fps.value.toFixed(4);
    return ret;
}

function format(obj: Record<string, string>) {
    const pad = Math.max(...Object.keys(obj).map(k => k.length)) + 1;
    return Object.entries(obj)
        .map(([k, v]) => k.padEnd(pad, ' ') + ": " + v);
}
</script>

<template>
    <div class="container" :class="{ 'no-stream': !stream }" :style="{ fontSize: size.width / 20 + 'px' }"
        ref="container">
        <template v-if="stream">
            <canvas ref="canvas" v-show="image" :width="image?.width" :height="image?.height"
                :style="canvasStyle"></canvas>
            <Overlay v-if="overlay !== false" class="stream-info" display="flex" type="hover-only" :font-size="4">
                <template v-if="name !== null">
                    <div style="width: 100%; text-align: center; margin: 1em 0; font-size: 1.4em">{{ name }}</div>
                    <div class="ruler" style="width: 100%; height: 1px; background-color: white; margin: 1em 0;"></div>
                </template>
                <div v-for="line, i in format(info())" :key="i" style="margin: 0.4em 0;">{{ line }}</div>
            </Overlay>
        </template>
        <template v-else>
            <Overlay class="no-stream-text" display="flex" :font-size="10">No Stream</Overlay>
        </template>
    </div>
</template>

<style scoped lang="scss">
.container {
    position: relative;
    background-color: black;
    background: repeating-linear-gradient(45deg,
            #111,
            #111 10px,
            #222 10px,
            #222 20px);
    overflow: hidden;

    canvas {
        margin: 0;
    }

    .stream-info {
        flex-direction: column;
        align-items: flex-start;
        padding: 0 1em;
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

    &>* {
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
    backdrop-filter: blur(2px) saturate(50%);
    -webkit-backdrop-filter: blur(2px) saturate(50%);
    color: white;
    font-family: 'Cascadia Code', 'Courier New', Courier, monospace;
    z-index: 10;
    white-space: pre;
}
</style>