<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Renderer-composed A-vs-B stereo composite (split-disparity-nodes 2026-07-09;
  anaglyph mode added by stereo-disparity-and-heatmap-nodes): the split match
  nodes each see only ONE fovea, and the renderer already binds both pre-warped
  fovea undistort pipes for the L/R views, so these composites live HERE as
  pure display work — no core, no extra transport, computed only while mounted
  (the on-demand ruling holds trivially).

  Modes:
   - "difference": |A − B| per channel (GPU 'difference' blend) — the old
     disparity kernel's diff view.
   - "anaglyph": red = A (LEFT eye), cyan = B (RIGHT eye) — A×#f00 and
     B×#0ff via 'multiply', composed additively ('lighter').
-->
<script setup lang="ts">
import { onMounted, ref, useTemplateRef, watch } from "vue";
import type { FramePayload } from "@lib/orchestrator/protocol";
import { NoCheck } from "@lib/util/vue";

const props = defineProps({
  title: {
    type: String,
    required: false,
    default: "",
  },
  /** The two frames to compose — bind two `usePipeFrame` payloads. */
  a: {
    type: NoCheck<FramePayload | null | undefined>(),
    required: false,
    default: undefined,
  },
  b: {
    type: NoCheck<FramePayload | null | undefined>(),
    required: false,
    default: undefined,
  },
  mode: {
    type: NoCheck<"difference" | "anaglyph">(),
    required: false,
    default: "difference",
  },
  theme: {
    type: String,
    required: false,
    default: "gray",
  },
});

const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const offA = document.createElement("canvas");
const offB = document.createElement("canvas");
// Reactive painted flag for the "No Frame" overlay — the plain `offA.width`
// the template previously read is NOT reactive, so the overlay never cleared
// once frames arrived (it re-evaluates only on a re-render, and no template
// dependency changed per frame).
const painted = ref(false);

/** Paint one payload into its offscreen canvas (4-channel only — every pipe
 *  frame is BGRA8; channel order cancels out of 'difference', and the
 *  anaglyph masks assume the same R/B convention StreamView renders with). */
function paint(p: FramePayload, off: HTMLCanvasElement): boolean {
  const [h = 0, w = 0] = p.shape;
  if (!w || !h || p.channels !== 4 || !p.data) return false;
  if (off.width !== w) off.width = w;
  if (off.height !== h) off.height = h;
  const clamped = new Uint8ClampedArray(p.data, 0, w * h * 4);
  off.getContext("2d")?.putImageData(
    new ImageData(clamped as Uint8ClampedArray<ArrayBuffer>, w, h),
    0,
    0,
  );
  return true;
}

/** Multiply `src` by a solid color into a scratch canvas (channel mask). */
function masked(src: HTMLCanvasElement, color: string, scratch: HTMLCanvasElement): HTMLCanvasElement {
  if (scratch.width !== src.width) scratch.width = src.width;
  if (scratch.height !== src.height) scratch.height = src.height;
  const ctx = scratch.getContext("2d");
  if (!ctx) return scratch;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, scratch.width, scratch.height);
  return scratch;
}
const maskA = document.createElement("canvas");
const maskB = document.createElement("canvas");

/** GPU composite of the two offscreens per `mode`. Sized to A. */
function composite(): void {
  const c = canvas.value;
  if (!c || !offA.width || !offB.width) return;
  if (c.width !== offA.width) c.width = offA.width;
  if (c.height !== offA.height) c.height = offA.height;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  if (props.mode === "anaglyph") {
    // Red = A (left eye), cyan = B (right eye): keep A's red channel and
    // B's green+blue, then add.
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(masked(offA, "#f00", maskA), 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(masked(offB, "#0ff", maskB), 0, 0, c.width, c.height);
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(offA, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "difference";
    ctx.drawImage(offB, 0, 0, c.width, c.height);
  }
  painted.value = true;
}

watch(
  () => props.a,
  (p) => {
    if (p && paint(p, offA)) composite();
  },
  { immediate: true },
);
watch(
  () => props.b,
  (p) => {
    if (p && paint(p, offB)) composite();
  },
  { immediate: true },
);
watch(() => props.mode, composite);
onMounted(composite);
</script>

<template>
  <div class="container" :class="{ 'no-frame': !painted }" :style="{ '--theme': theme }">
    <div class="title" v-if="title !== null">
      <span>{{ title }}</span>
      <div class="title-slot">
        <slot name="title"></slot>
      </div>
    </div>
    <canvas ref="canvas" class="centered"></canvas>
    <div v-if="!painted" class="no-frame-text centered">No Frame</div>
  </div>
</template>

<style scoped lang="scss">
// Chrome mirrors FrameView's container (same look in the view grid).
.container {
  position: relative;
  background: repeating-linear-gradient(45deg, #111, #111 10px, #222 10px, #222 20px);
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
  }

  &:hover .title {
    color: var(--theme, gray);
  }

  &.no-frame {
    outline-color: #444 !important;
  }

  .no-frame-text {
    color: #444;
    font-size: 2em;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  & > .centered {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    max-width: 100%;
    max-height: 100%;
  }

  &:not(:hover) {
    outline: none !important;
  }
}
</style>
