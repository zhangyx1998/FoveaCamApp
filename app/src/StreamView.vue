<script setup lang="ts">
import { type Camera, type Stream } from 'core';
import { computed, onUnmounted, ref, shallowRef, useTemplateRef, watch } from 'vue';

import { ElementSize } from '@lib/util/dom';

const props = defineProps<{ camera?: Camera, stream?: Stream }>();
const container = useTemplateRef<HTMLDivElement>("container");
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const size = new ElementSize(container);
const controller = new AbortController();

onUnmounted(() => controller.abort());

const fps = ref(0);
const image = shallowRef<ImageData | null>(null);
let t0: number | null = null;
let dt: number | null = null;

function updateFPS(t1: number, decay = 0.9) {
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
                new Uint8ClampedArray(frame.view("RGBa8")),
                frame.width,
                frame.height
            )
            else frame.view("RGBa8", image.value.data);
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
    if (props.camera) {
        ret["Model"] = props.camera.model;
        ret["Serial"] = props.camera.serial;
    }
    if (image.value) {
        ret["Size"] = `${image.value.width} x ${image.value.height}`;
    }
    ret["FPS"] = fps.value.toFixed(4);
    return ret;
}

function format(obj: Record<string, string>) {
    const pad = Math.max(...Object.keys(obj).map(k => k.length)) + 1;
    return Object.entries(obj)
        .map(([k, v]) => `${k.padEnd(pad, ' ')}: ${v}`)
        .join("\n");
}
</script>

<template>
    <div class="container" ref="container" v-if="stream">
        <canvas ref="canvas" v-show="image" :width="image?.width" :height="image?.height" :style="canvasStyle"></canvas>
        <pre class="overlay" v-html="format(info())"></pre>
    </div>
    <div class="container no-stream" v-else></div>
</template>

<style scoped>
.container {
    position: relative;
    background-color: black;
    overflow: hidden;
}

.container.no-stream {
    background: repeating-linear-gradient(45deg,
            #222,
            #222 10px,
            #333 10px,
            #333 20px);
}

.container>* {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
}

.overlay {
    position: absolute;
    width: 100%;
    height: 100%;
    padding: 1em;
    vertical-align: middle;
    background-color: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(5px) saturate(50%);
    -webkit-backdrop-filter: blur(5px) saturate(50%);
    color: white;
    font-family: 'Cascadia Code', 'Courier New', Courier, monospace;
    z-index: 10;
}

.container .overlay {
    display: none;
}

.container:hover .overlay {
    display: block;
}
</style>