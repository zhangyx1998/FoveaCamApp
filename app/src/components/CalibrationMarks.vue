<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  The SHARED observed-vs-projected mark set (calibration-records-v2.md
  §Visualizer). Renders ONLY SVG marks (an `<g>`, no `<svg>` wrapper) in the
  camera's SENSOR-PIXEL coordinate space, so it drops into ANY host SVG at that
  scale: the standalone `CalibrationVisualizer` wraps it in its own viewBox'd
  `<svg>`, and the live calibrate-extrinsic view mounts it inside a `StreamView`
  slot (whose slot coordinates are already sensor pixels — the same space the
  observed `img_points` live in). One renderer, two hosts.

  Observed corners are dots; projected (solve) corners are crosses; a faint
  segment joins each pair so the residual reads at a glance. Mark sizes track the
  projection's own point-cloud span, so they stay legible from 4 to 400
  datapoints regardless of host.
-->
<script setup lang="ts">
import { computed } from "vue";
import { projectDataset } from "@lib/calibration-visualizer";
import type { ExtrinsicDataset } from "@lib/camera-config";

const props = withDefaults(
  defineProps<{
    dataset: ExtrinsicDataset;
    /** Base mark color for OBSERVED points. */
    color?: string;
    /** Color for PROJECTED (solve) points. */
    projColor?: string;
  }>(),
  { color: "var(--accent-bright)", projColor: "var(--warn)" },
);

const proj = computed(() => projectDataset(props.dataset));
// Size marks off the point-cloud span so they stay legible at any datapoint
// count and in any host (standalone viewBox or a live sensor-space stream).
const span = computed(() => {
  const b = proj.value.bounds;
  return Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
});
const dot = computed(() => span.value / 260);
const arm = computed(() => span.value / 150);
const stroke = computed(() => span.value / 900);
</script>

<template>
  <g class="cal-marks">
    <g v-for="(pt, pi) in proj.points" :key="pi">
      <line
        v-for="(o, ci) in pt.observed"
        :key="'s' + ci"
        :x1="o.x"
        :y1="o.y"
        :x2="pt.projected[ci]!.x"
        :y2="pt.projected[ci]!.y"
        stroke="var(--text-faint)"
        :stroke-width="stroke"
        opacity="0.7"
      />
      <g
        v-for="(p, ci) in pt.projected"
        :key="'p' + ci"
        :stroke="projColor"
        :stroke-width="stroke * 1.4"
      >
        <line :x1="p.x - arm" :y1="p.y" :x2="p.x + arm" :y2="p.y" />
        <line :x1="p.x" :y1="p.y - arm" :x2="p.x" :y2="p.y + arm" />
      </g>
      <circle
        v-for="(o, ci) in pt.observed"
        :key="'o' + ci"
        :cx="o.x"
        :cy="o.y"
        :r="dot"
        :fill="color"
      />
    </g>
  </g>
</template>
