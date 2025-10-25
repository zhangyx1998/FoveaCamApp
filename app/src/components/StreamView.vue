<script setup lang="ts">
import type { Frame, Stream } from "core";
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
import { FreqMeter, PerfTimer } from "@lib/util/perf";
import Overlay from "./Overlay.vue";
import abortable from "@lib/abortable";

const props = defineProps({
    name: {
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
        type: Object as () => Stream<Frame> | undefined,
        required: false,
        default: undefined,
    },
    overlay: {
        type: Object as () => Boolean | Record<string, string>,
        required: false,
        default: true,
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
});

const container = useTemplateRef<HTMLDivElement>("container");
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const size = new ElementSize(container);
const canvasSize = new ElementSize(canvas);
const controller = new AbortController();
const overlayToggle = ref(false);

onUnmounted(() => controller.abort());

const fps = new FreqMeter();
const perf = new PerfTimer();
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

function createTask(stream?: Stream<Frame>) {
    if (!stream) return null;
    return abortable(async (aborted) => {
        try {
            for (const frame of stream) {
                if (aborted()) break;
                if (!frame) {
                    await new Promise(requestAnimationFrame);
                    continue;
                }
                if (!image.value)
                    image.value = new ImageData(
                        new Uint8ClampedArray(
                            await perf.measure(() => frame.view("BGRA8"))
                        ),
                        frame.width,
                        frame.height
                    );
                else
                    await perf.measure(() =>
                        frame.view("BGRA8", image.value!.data)
                    );
                frame.release();
                fps.tick();

                const ctx = canvas.value?.getContext("2d");
                if (ctx) ctx.putImageData(image.value, 0, 0);
                await new Promise(requestAnimationFrame);
            }
        } catch (e) {
            console.error(e);
        }
    });
}

const task = computed(() => createTask(props.stream));
watch(task, (_, prev) => prev?.abort());
onUnmounted(() => task.value?.abort());

const overlayEntries = computed(() => {
    const ret: Record<string, string> = {};
    if (typeof props.overlay === "object") Object.assign(ret, props.overlay);
    if (image.value)
        ret["Size"] = `${image.value.width} x ${image.value.height}`;
    ret["FPS"] = fps.toString() + " Hz";
    ret["Cvt Time"] = perf.toString() + " ms";
    const pad = Math.max(...Object.keys(ret).map((k) => k.length)) + 1;
    return Object.entries(ret).map(([k, v]) => k.padEnd(pad, " ") + ": " + v);
});

const style = computed<StyleValue>(() => {
    const ret: StyleValue = {
        fontSize: size.width / 20 + "px",
        "--theme": props.theme,
    };
    if (props.name !== null) ret.marginTop = "1.6em";
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
</script>

<template>
    <div
        class="container"
        :class="{ 'no-stream': !stream }"
        :style="style"
        ref="container"
        @mousedown.right.prevent="overlayToggle = !overlayToggle"
    >
        <div class="title" v-if="name !== null">
            {{ name }}
        </div>
        <div class="footnote" v-if="footnote !== null">
            {{ footnote }}
        </div>
        <template v-if="stream">
            <canvas
                ref="canvas"
                class="centered"
                v-show="image"
                :width="image?.width"
                :height="image?.height"
                :style="canvasStyle"
            ></canvas>
            <Overlay
                v-if="overlay && overlayToggle"
                class="stream-info centered"
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
                >No Stream</Overlay
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
