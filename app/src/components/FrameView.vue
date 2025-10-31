<script setup lang="ts">
import { Vision, type Mat, type Point, type Rect, type Size } from "core";
import {
    computed,
    onUnmounted,
    ref,
    shallowRef,
    StyleValue,
    useTemplateRef,
    watch,
} from "vue";

import { ElementSize } from "@lib/util/dom";
import Overlay from "./Overlay.vue";

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
    mat: {
        type: Object as () => Mat<Uint8Array> | null,
        required: false,
        default: null,
    },
    overlay: {
        type: Object as () => Boolean | Record<string, string>,
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

const container = useTemplateRef<HTMLDivElement>("container");
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const size = new ElementSize(container);
const canvasSize = new ElementSize(canvas);
const controller = new AbortController();
const overlayToggle = ref(false);

onUnmounted(() => controller.abort());
const image = shallowRef<ImageData | null>(null);

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

watch(canvas, (canvas) => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx && image.value) {
        ctx.putImageData(image.value, 0, 0);
    }
});

watch(
    () => props.mat,
    (mat) => {
        if (!mat) return (image.value = null);
        if (props.slice) mat = Vision.slice(mat, props.slice);
        const [height, width] = mat.shape;
        switch (mat.channels) {
            case 1: {
                // Convert Gray to RGBA
                const rgba = new Uint8Array(width * height * 4);
                for (let i = 0; i < width * height; i++) {
                    const byte = mat[i];
                    rgba[i * 4] = byte;
                    rgba[i * 4 + 1] = byte;
                    rgba[i * 4 + 2] = byte;
                    rgba[i * 4 + 3] = 255;
                }
                mat = Object.assign(rgba, {
                    channels: 4,
                    shape: [height, width],
                });
                break;
            }
            case 3: {
                // Convert RGB to RGBA
                const rgba = new Uint8Array(width * height * 4);
                for (let i = 0; i < width * height; i++) {
                    rgba[i * 4] = mat[i * 3];
                    rgba[i * 4 + 1] = mat[i * 3 + 1];
                    rgba[i * 4 + 2] = mat[i * 3 + 2];
                    rgba[i * 4 + 3] = 255;
                }
                mat = Object.assign(rgba, {
                    channels: 4,
                    shape: [height, width],
                });
                break;
            }
            case 4:
                break;
            default:
                console.error(
                    `Unsupported number of channels: ${mat.channels}`
                );
                return;
        }
        const clamped = new Uint8ClampedArray(mat.buffer);
        image.value = new ImageData(
            clamped as Uint8ClampedArray<ArrayBuffer>,
            width,
            height
        );
        const ctx = canvas.value?.getContext("2d");
        if (ctx) ctx.putImageData(image.value, 0, 0);
    },
    { immediate: true }
);

const overlayEntries = computed(() => {
    if (!props.overlay) return [];
    const entries = Object.entries(props.overlay);
    const pad = Math.max(...entries.map(([k]) => k.length)) + 1;
    return entries.map(([k, v]) => k.padEnd(pad, " ") + ": " + v);
});

const style = computed<StyleValue>(() => {
    const ret: StyleValue = {
        fontSize: size.width / 20 + "px",
        "--theme": props.theme,
    };
    if (props.title !== null) ret.marginTop = "1.6em";
    if (props.footnote !== null) ret.marginBottom = "1.6em";
    if (props.width !== null || props.height !== null) {
        if (props.width !== null && props.height !== null) {
            ret.width = props.width;
            ret.height = props.height;
        } else if (image.value !== null) {
            const { width, height } = image.value;
            if (props.height !== null) {
                ret.height = props.height;
                ret.width = (size.height * width) / height + "px";
            } else {
                ret.width = props.width;
                ret.height = (size.width * height) / width + "px";
            }
        }
    }
    return ret;
});

const viewBox = computed(() => {
    if (!image.value) return `0 0 100 100`;
    return `0 0 ${image.value.width} ${image.value.height}`;
});

function translatePos<T extends MouseEvent | PointerEvent>(
    e: T
): Point & Size & T {
    const { width = 0, height = 0 } = image.value ?? {};
    if (!canvas.value)
        return { ...e, x: 0, y: 0, width, height } as Point & Size & T;
    const rect = canvas.value.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const { width: cw, height: ch } = canvasSize;
    const { width: iw, height: ih } = image.value!;
    const x = (cx / cw) * iw;
    const y = (cy / ch) * ih;
    const {
        button,
        buttons,
        clientX,
        clientY,
        ctrlKey,
        shiftKey,
        altKey,
        metaKey,
        target,
    } = e;
    return {
        button,
        buttons,
        clientX,
        clientY,
        ctrlKey,
        shiftKey,
        altKey,
        metaKey,
        target,
        x,
        y,
        width,
        height,
    } as Point & Size & T;
}
</script>

<template>
    <div
        class="container"
        :class="{ 'no-frame': !image }"
        :style="style"
        ref="container"
        @mousedown.right.prevent="overlayToggle = !overlayToggle"
    >
        <div class="title" v-if="title !== null">
            {{ title }}
        </div>
        <div class="footnote" v-if="footnote !== null">
            {{ footnote }}
        </div>
        <template v-if="image">
            <canvas
                ref="canvas"
                class="centered"
                v-show="image"
                :width="image?.width"
                :height="image?.height"
                :style="canvasStyle"
                @mousedown="(e) => emit('mousedown', translatePos(e))"
                @mouseup="(e) => emit('mouseup', translatePos(e))"
                @mousemove="(e) => emit('mousemove', translatePos(e))"
                @mouseleave="(e) => emit('mouseleave', translatePos(e))"
                @pointerdown="(e) => emit('pointerdown', translatePos(e))"
                @pointerup="(e) => emit('pointerup', translatePos(e))"
                @pointermove="(e) => emit('pointermove', translatePos(e))"
                @pointerleave="(e) => emit('pointerleave', translatePos(e))"
            ></canvas>
            <Overlay
                v-if="overlay && overlayToggle"
                class="frame-info centered"
                display="flex"
                :font-size="4"
            >
                <div
                    v-for="(line, i) in overlayEntries"
                    :key="i"
                    style="margin: 0.2em 0"
                >
                    {{ line }}
                </div>
            </Overlay>
            <svg
                :viewBox="viewBox"
                class="annotations centered"
                :width="canvasSize.width + 'px'"
                :height="canvasSize.height + 'px'"
            >
                <slot></slot>
            </svg>
        </template>
        <template v-else>
            <Overlay
                class="no-stream-text centered"
                display="flex"
                :font-size="10"
                >No Frame</Overlay
            >
        </template>
    </div>
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

    .frame-info {
        flex-direction: column;
        justify-content: center;
        align-items: left;
        overflow-y: scroll;
    }

    &.no-frame {
        outline-color: #444 !important;
    }

    .no-frame-text {
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

    .annotations {
        pointer-events: none;
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
