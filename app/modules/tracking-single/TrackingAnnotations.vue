<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  tracking-single's center-view annotation overlay (A-21 / A-P6 fold): the
  predicted-target dot + tracker bounding box, extracted from the inline
  StreamView slot into a reusable, telemetry-driven component. Renders bare SVG
  children meant to sit inside a FrameView `annotations` <svg> (via StreamView's
  default slot), so both the main view AND the debug sub-window (WS2 2b) draw
  the exact same overlay from the same session telemetry.
-->
<script setup lang="ts">
import { computed } from "vue";
import { THEME } from "@lib/camera-config";
import type { Session } from "@lib/orchestrator/client";
import type { TrackingContract } from "./contract";

const props = defineProps<{ session: Session<TrackingContract> }>();
const t = computed(() => props.session.telemetry);
// Stroke scales with frame size so it reads at any resolution.
const stroke = computed(() => Math.max(t.value.size.width, t.value.size.height, 1) * 0.003);
</script>

<template>
  <!-- Target (predicted) location. -->
  <circle :cx="t.target.x" :cy="t.target.y" :r="stroke * 3" :fill="THEME.C" />
  <!-- Tracker bounding box. -->
  <rect
    v-if="t.bbox"
    :x="t.bbox.x"
    :y="t.bbox.y"
    :width="t.bbox.width"
    :height="t.bbox.height"
    stroke="#0f0"
    :stroke-width="stroke"
    fill="none"
  />
</template>
