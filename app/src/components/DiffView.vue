<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Renderer-composed A-vs-B difference view (split-disparity-nodes,
  2026-07-09): the old disparity kernel's `center.disparity` frame was
  `diff(alignedL, alignedR)` — but the split match nodes each see only ONE
  fovea, and the renderer already binds both pre-warped fovea undistort pipes
  for the L/R views, so the diff is composed HERE as a pure display composite:
  two offscreen canvases + a GPU 'difference' blend. No core, no extra
  transport — the pipes it reads are already flowing.
-->
<script setup lang="ts">
import { onMounted, useTemplateRef, watch } from "vue";
import type { FramePayload } from "@lib/orchestrator/protocol";
import { NoCheck } from "@lib/util/vue";

const props = defineProps({
  title: {
    type: String,
    required: false,
    default: "",
  },
  /** The two frames to diff — bind two `usePipeFrame` payloads. */
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
  theme: {
    type: String,
    required: false,
    default: "gray",
  },
});

const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const offA = document.createElement("canvas");
const offB = document.createElement("canvas");

/** Paint one payload into its offscreen canvas (4-channel only — every pipe
 *  frame is BGRA8; the channel order cancels out of a difference blend). */
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

/** GPU blend: |A - B| per channel ('difference' composite). Sized to A. */
function composite(): void {
  const c = canvas.value;
  if (!c || !offA.width || !offB.width) return;
  if (c.width !== offA.width) c.width = offA.width;
  if (c.height !== offA.height) c.height = offA.height;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(offA, 0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "difference";
  ctx.drawImage(offB, 0, 0, c.width, c.height);
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
onMounted(composite);
</script>

<template>
  <div class="container" :class="{ 'no-frame': !offA.width }" :style="{ '--theme': theme }">
    <div class="title" v-if="title !== null">
      <span>{{ title }}</span>
      <div class="title-slot">
        <slot name="title"></slot>
      </div>
    </div>
    <canvas ref="canvas" class="centered"></canvas>
    <div v-if="!offA.width || !offB.width" class="no-frame-text centered">No Frame</div>
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
