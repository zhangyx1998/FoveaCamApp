<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->

<!-- Minimal canvas line chart — no chart dependency, per docs/history/refactor/
     orchestrator.md §7.1 S4. `values` is oldest -> newest; `max` fixes the
     scale (auto-scales to the data's own max otherwise). -->

<script setup lang="ts">
import { useTemplateRef, watch } from "vue";

const props = withDefaults(
  defineProps<{
    values: number[];
    max?: number;
    color?: string;
    width?: number;
    height?: number;
  }>(),
  { width: 240, height: 36, color: "#0af" },
);

const canvas = useTemplateRef("canvas");

function draw() {
  const el = canvas.value;
  const ctx = el?.getContext("2d");
  if (!ctx) return;
  const { width, height, values } = props;
  ctx.clearRect(0, 0, width, height);
  if (values.length < 2) return;
  const max = props.max ?? Math.max(1e-6, ...values);
  ctx.strokeStyle = props.color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - (Math.min(Math.max(v, 0), max) / max) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

watch(() => [props.values, props.max, props.color], draw, { deep: true, immediate: true });
</script>

<template>
  <canvas ref="canvas" :width="width" :height="height" class="sparkline"></canvas>
</template>

<style scoped lang="scss">
.sparkline {
  display: block;
  background: var(--bg-chrome);
  border: 1px solid var(--bg-app);
  border-radius: 2px;
}
</style>
