<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  One annotation on the welcome preview's SVG canvas: an anchor dot at
  (x, y) — percent coordinates within the preview — with a label/value pair
  beside it. Data-bound (label/value come from orchestrator-synced state);
  positioning is the caller's markup (`x`/`y`/`dx`/`dy` attributes), meant to
  be hand-edited — see AnnotationCanvas.vue.

  The inner <text> uses a fixed font-size in a non-scaling wrapper: the
  canvas viewBox is 0..100 with preserveAspectRatio="none", so raw text
  would stretch; `transform` into a per-annotation local frame keeps glyphs
  undistorted while the anchor stays in percent space.
-->
<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Stable id — also the SVG element id (hand-editing landmark). */
    id: string;
    /** Anchor position, percent of the preview area. */
    x: number;
    y: number;
    /** Label offset from the anchor, in pixels. */
    dx?: number;
    dy?: number;
    label: string;
    value?: string;
  }>(),
  { dx: 12, dy: 0, value: "" },
);
</script>

<template>
  <g :id="id" class="annotation">
    <circle :cx="x" :cy="y" r="0.6" class="anchor" />
    <!-- vector-effect keeps the dot/text from stretching with the 100x100
         viewBox; the foreignObject carries plain HTML text (SVG <text> under
         preserveAspectRatio="none" would shear glyphs). -->
    <foreignObject
      :x="x"
      :y="y"
      width="1"
      height="1"
      class="label-frame"
      overflow="visible"
    >
      <div
        class="label"
        :style="{ transform: `translate(${dx}px, calc(${dy}px - 50%))` }"
      >
        <span class="key">{{ label }}</span>
        <span v-if="value" class="value">{{ value }}</span>
      </div>
    </foreignObject>
  </g>
</template>

<style scoped>
.anchor {
  fill: #0af;
  stroke: white;
  stroke-width: 0.15;
}

.label-frame {
  pointer-events: none;
}

.label {
  display: inline-flex;
  gap: 0.6ch;
  align-items: baseline;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.4;
  background: #000a;
  border: 1px solid #fff3;
  border-radius: 3px;
  padding: 1px 6px;
  width: max-content;
}

.key {
  color: #9cf;
}

.value {
  color: #eee;
}
</style>
