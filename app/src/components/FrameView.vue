<script lang="ts">
export type TransformFunction = (mat: any) => any;
</script>

<script setup lang="ts">
import type { Mat } from "core/Vision";
import type { Point, Size } from "core/Geometry";
import {
  computed,
  ref,
  shallowRef,
  StyleValue,
  useTemplateRef,
  watch,
} from "vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faExpand } from "@fortawesome/free-solid-svg-icons";

import ElementSize from "@lib/element-size";
import { NoCheck } from "@lib/util/vue";
import FrameOverlay from "./FrameOverlay.vue";
import { current_capture, Delegation } from "../capture";
import { clamp } from "@lib/util";

const props = defineProps({
  title: {
    type: String,
    required: false,
    default: "",
  },
  footnote: {
    type: String,
    required: false,
    default: null,
  },
  mat: {
    type: NoCheck<Mat | null>(),
    required: false,
    default: null,
  },
  transform: {
    type: NoCheck<TransformFunction | undefined>(),
    required: false,
    default: undefined,
  },
  overlay: {
    type: NoCheck<Boolean | Record<string, string>>(),
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
  capture: {
    type: NoCheck<Delegation | string | null>(),
    required: false,
    default: null,
  },
  // Stream address for the expand button (multi-window.md req. 4): when set,
  // the button opens a projection window for this session+frame channel
  // instead of element-fullscreening the container (the pre-Stage-5
  // behavior, kept as the fallback for local/unaddressed frames).
  projection: {
    type: NoCheck<{ session: string; frame: string } | null>(),
    required: false,
    default: null,
  },
});

const emit = defineEmits<{
  (
    e: "update:modelValue",
    event: (Point & Size & { buttons: number }) | null,
  ): void;
  (e: "mouse", event: (Point & Size & { buttons: number }) | null): void;
}>();

const container = useTemplateRef<HTMLDivElement>("container");
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");

// Expand button: projection window when the stream is addressable (session +
// frame channel known), legacy element-fullscreen otherwise.
function expand(): void {
  if (props.projection)
    window.foveaBridge.openProjectionWindow(
      props.projection.session,
      props.projection.frame,
    );
  else container.value?.requestFullscreen();
}
const size = new ElementSize(container);
const canvasSize = new ElementSize(canvas);
const overlayToggle = ref(false);

const image = shallowRef<ImageData | null>(null);
const { capture } = props;
if (typeof capture === "function")
  capture(() => (mat.value ? { image: mat.value } : null));
else if (typeof capture === "string")
  current_capture.value?.provide((provide) => {
    const image = mat.value;
    if (image) provide(capture, { image });
  });

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

const mat = computed(() => {
  let { mat, transform } = props;
  if (!mat) return null;
  try {
    if (transform) mat = transform(mat);
  } catch (e) {
    console.error("Error applying transform to mat:", e);
    return null;
  }
  return mat;
});

// Expand a 1- or 3-channel Mat to 4-channel (RGBA, alpha=255) in plain JS —
// every renderer-reachable Mat now arrives via `payloadToMat` (always
// `Uint8Array`, always 4-channel BGRA/RGBA already, see the wire's
// `toFramePayload`), so this is dead code on any *current* call path, but
// kept as a real (not native-backed) implementation so the component stays
// correct for a 1/3-channel Mat rather than silently regressing if one ever
// shows up again. Replaces the old `core/Vision` `cvtColor` calls — the
// last native runtime dependency in the renderer bundle (docs/refactor/
// orchestrator.md §7.1 Stage 3 T1).
function expandToRGBA(src: Uint8Array, channels: 1 | 3): Uint8Array {
  const pixels = src.length / channels;
  const out = new Uint8Array(pixels * 4);
  if (channels === 1) {
    for (let i = 0, j = 0; i < src.length; i++, j += 4) {
      out[j] = out[j + 1] = out[j + 2] = src[i];
      out[j + 3] = 255;
    }
  } else {
    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
      out[j] = src[i];
      out[j + 1] = src[i + 1];
      out[j + 2] = src[i + 2];
      out[j + 3] = 255;
    }
  }
  return out;
}

watch(
  mat,
  async (mat) => {
    if (!mat) return (image.value = null);
    if (!(mat instanceof Uint8Array)) {
      console.error("FrameView: expected a Uint8Array Mat, got", mat);
      return (image.value = null);
    }
    const [height, width] = mat.shape;
    let data: Uint8Array;
    switch (mat.channels) {
      case 1:
      case 3:
        data = expandToRGBA(mat, mat.channels);
        break;
      case 4:
        data = mat;
        break;
      default:
        console.error(`Unsupported number of channels: ${mat.channels}`);
        return (image.value = null);
    }
    const clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    image.value = new ImageData(
      clamped as Uint8ClampedArray<ArrayBuffer>,
      width,
      height,
    );
    const ctx = canvas.value?.getContext("2d");
    if (ctx) ctx.putImageData(image.value, 0, 0);
  },
  { immediate: true },
);

const overlayEntries = computed(() => {
  if (!props.overlay) return [];
  const entries = Object.entries(props.overlay);
  const pad = Math.max(...entries.map(([k]) => k.length)) + 1;
  return entries.map(([k, v]) => k.padEnd(pad, " ") + ": " + v);
});

const style = computed<StyleValue>(() => {
  const ret: StyleValue = {
    marginTop: "1.6em",
    fontSize: `min(1.2em, ${size.width / 20}px)`,
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

function translatePos(
  e: MouseEvent | PointerEvent,
): Point & Size & { buttons: number } {
  const { buttons } = e;
  const { width: iw = 0, height: ih = 0 } = image.value ?? {};
  if (!canvas.value)
    return { x: iw / 2, y: ih / 2, width: iw, height: ih, buttons };
  const rect = canvas.value.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const { width: cw, height: ch } = canvasSize;
  const x = clamp((cx / cw) * iw, [0, iw]);
  const y = clamp((cy / ch) * ih, [0, ih]);
  return {
    x,
    y,
    width: iw,
    height: ih,
    buttons,
  };
}

const drag = ref(false);
function trackUntilRelease(e: MouseEvent) {
  if (!(e.buttons & 1)) return untrack();
  return emit("update:modelValue", translatePos(e));
}

function untrack() {
  drag.value = false;
  window.removeEventListener("mousemove", trackUntilRelease);
  window.removeEventListener("mouseup", trackUntilRelease);
  return emit("update:modelValue", null);
}

function track(e: MouseEvent) {
  drag.value = true;
  window.addEventListener("mousemove", trackUntilRelease);
  window.addEventListener("mouseup", trackUntilRelease);
  trackUntilRelease(e);
}

function mix<T, P>(t: T, p: P): T & P {
  return {
    ...t,
    ...p,
  };
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
      <span>{{ title }}</span>
      <div class="title-slot">
        <slot name="title"></slot>
      </div>
      <button
        class="fullscreen"
        :title="projection ? 'Open projection window' : 'Toggle Fullscreen'"
        @click="expand"
      >
        <Icon :icon="faExpand" />
      </button>
    </div>
    <div class="footnote" v-if="footnote !== null">
      {{ footnote }}
    </div>
    <slot name="suffix"></slot>
    <template v-if="image">
      <canvas
        ref="canvas"
        class="centered"
        v-show="image"
        :width="image?.width"
        :height="image?.height"
        :style="canvasStyle"
        @mousedown="(e) => [track(e), emit('mouse', translatePos(e))]"
        @mousemove="(e) => emit('mouse', translatePos(e))"
        @mouseleave="() => emit('mouse', null)"
        @mouseenter="(e) => emit('mouse', translatePos(e))"
        @mouseup="(e) => emit('mouse', translatePos(e))"
      ></canvas>
      <FrameOverlay
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
      </FrameOverlay>
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
      <FrameOverlay
        class="no-stream-text centered"
        display="flex"
        :font-size="10"
        >No Frame</FrameOverlay
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
    display: flex;
    align-items: center;

    .title-slot {
      flex: 1;
      display: flex;
      align-items: center;
      min-width: 0;
      overflow: hidden;
      justify-content: flex-start;
    }

    .fullscreen {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0 0.5ch;
      opacity: 0.5;
      &:hover {
        opacity: 1;
      }
    }
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
