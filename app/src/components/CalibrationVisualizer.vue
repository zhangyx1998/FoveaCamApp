<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Extrinsic-calibration visualizer (calibration-records-v2.md §Visualizer). A
  VIRTUAL STREAM — no frame buffers: it draws, at the camera's aspect ratio,
  every recorded datapoint's OBSERVED corner points (dots) against the
  INVERSE-PROJECTED corners the calibration solve expects (crosses), joined by a
  faint error segment so the reprojection residual reads at a glance. The
  projection math is the SHARED pure `@lib/calibration-visualizer` (the same
  construction `findPinholeProjection` fits) — no camera math is reimplemented,
  and it stays core-free so this renders in any renderer window.

  ONE component, TWO hosts (the ruled shared-renderer rule): the Settings
  window's "Inspect" opens it in a panel (default), and a live calibrate-extrinsic
  view mounts the SAME component with `overlay` (transparent background, no
  chrome) on top of its stream when the overlay toggle targets its camera.
-->
<script setup lang="ts">
import { computed } from "vue";
import { projectDataset, viewBoxFor } from "@lib/calibration-visualizer";
import type { ExtrinsicDataset } from "@lib/camera-config";
import CalibrationMarks from "./CalibrationMarks.vue";

const props = withDefaults(
  defineProps<{
    /** The record's immutable inner datapoint array. */
    dataset: ExtrinsicDataset;
    /** Camera sensor size (true aspect ratio); falls back to the data bounds. */
    sensorSize?: { width: number; height: number } | null;
    /** Overlay mode: transparent background + no legend/chrome (mount over a
     *  live stream). */
    overlay?: boolean;
    /** Per-record base color for the observed marks. */
    color?: string;
  }>(),
  { sensorSize: null, overlay: false, color: "var(--accent-bright)" },
);

const proj = computed(() => projectDataset(props.dataset));
const vb = computed(() => viewBoxFor(proj.value, props.sensorSize));
const viewBox = computed(
  () => `${vb.value.x} ${vb.value.y} ${vb.value.width} ${vb.value.height}`,
);
const stroke = computed(() => Math.max(vb.value.width, vb.value.height) / 900);
const projColor = "var(--warn)";
</script>

<template>
  <div class="cal-viz" :class="{ overlay }">
    <svg
      :viewBox="viewBox"
      preserveAspectRatio="xMidYMid meet"
      class="cal-svg"
      role="img"
      aria-label="Observed versus projected calibration corners"
    >
      <!-- Sensor frame (only when a real sensor size is known). -->
      <rect
        v-if="sensorSize"
        :x="vb.x"
        :y="vb.y"
        :width="vb.width"
        :height="vb.height"
        class="frame"
        :stroke-width="stroke * 2"
        fill="none"
      />
      <!-- Shared observed-vs-projected marks (same component the live overlay
           mounts inside a StreamView slot). -->
      <CalibrationMarks :dataset="dataset" :color="color" :proj-color="projColor" />
    </svg>
    <div v-if="!overlay" class="legend">
      <span class="li"><span class="swatch dot" :style="{ background: color }"></span>Observed</span>
      <span class="li"><span class="swatch cross" :style="{ color: projColor }">+</span>Projected</span>
      <span class="rms">RMS {{ proj.rms.toFixed(2) }} px · {{ proj.points.length }} pts</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.cal-viz {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
  height: 100%;
  min-height: 0;

  &.overlay {
    // Overlay-on-live: no chrome, fill the host, don't intercept pointer events.
    gap: 0;
    pointer-events: none;
  }
}

.cal-svg {
  flex: 1;
  min-height: 0;
  width: 100%;
  background: var(--bg-app);
  border-radius: 4px;

  .overlay & {
    background: transparent;
  }

  .frame {
    stroke: var(--border-muted);
  }
}

.legend {
  display: flex;
  align-items: center;
  gap: 1.4ch;
  flex-wrap: wrap;
  color: var(--text-muted);
  font-size: var(--fs-sm);

  .li {
    display: flex;
    align-items: center;
    gap: 0.5ch;
  }
  .swatch {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1em;
    height: 1.1em;
    &.dot {
      border-radius: 50%;
    }
    &.cross {
      font-weight: 800;
    }
  }
  .rms {
    margin-left: auto;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
}
</style>
