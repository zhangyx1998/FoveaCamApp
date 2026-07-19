<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Marker-detection annotation: the outline <path> around the
  detected quad, size-scaled corner dots with a black rim, and the marker ID
  rendered at the detection center — all sized off the marker's on-screen
  span and themed via `--theme` so each eye keeps its role color. Renders
  inside a StreamView's SVG slot (sensor-pixel coordinate space).
-->
<script setup lang="ts">
import { computed } from "vue";
import type { Point2d } from "core/Geometry";

const props = defineProps<{
  /** Detected corner points — the first 4 are the marker's outer quad;
   *  any further points (internal corners) render as dots only. */
  points: Point2d[];
  /** Marker id to print at the center (omit to skip the label — e.g. when
   *  internal-corner dots would collide with it). */
  id?: number;
  /** Theme color (defaults to the surrounding `--theme`). */
  color?: string;
}>();

const style = computed(() =>
  props.color ? { "--theme": props.color } : undefined,
);
/** On-screen marker span = the largest pairwise corner distance
 *  (outline/dot weights and the ID font all scale from it). */
const size = computed(() => {
  const q = props.points.slice(0, 4);
  let max = 0;
  for (let i = 0; i < q.length; i++)
    for (let j = i + 1; j < q.length; j++)
      max = Math.max(max, Math.hypot(q[j].x - q[i].x, q[j].y - q[i].y));
  return max;
});
const center = computed(() => {
  const q = props.points.slice(0, 4);
  if (q.length === 0) return { x: 0, y: 0 };
  return {
    x: q.reduce((a, p) => a + p.x, 0) / q.length,
    y: q.reduce((a, p) => a + p.y, 0) / q.length,
  };
});
const outline = computed(() => {
  const q = props.points.slice(0, 4);
  if (q.length < 3) return "";
  return `M${q.map((p) => `${p.x} ${p.y}`).join("L")}Z`;
});
const weight = computed(() => Math.max(2, size.value * 0.04));
</script>

<template>
  <g :style="style">
    <path
      v-if="outline"
      :d="outline"
      style="stroke: var(--theme)"
      :stroke-width="weight"
      fill="none"
    />
    <circle
      v-for="(p, i) in points"
      :key="i"
      :cx="p.x"
      :cy="p.y"
      :r="weight"
      fill="var(--theme)"
      stroke="black"
      :stroke-width="Math.max(1, size * 0.02)"
    />
    <text
      v-if="id !== undefined"
      :x="center.x"
      :y="center.y"
      :font-size="size * 0.8"
      text-anchor="middle"
      dominant-baseline="central"
      fill="var(--theme)"
      opacity="0.85"
    >
      {{ id }}
    </text>
  </g>
</template>
