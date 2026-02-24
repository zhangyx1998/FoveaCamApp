<script setup lang="ts">
import { degrees } from "@lib/util";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import type { Point2d } from "core/Geometry";
defineProps<{ drift: Point2d | Empty }>();
</script>

<template>
  <ConfigEntry>
    <span style="margin-right: 2ch">
      <slot></slot>
    </span>
    <span v-if="drift">
      X {{ degrees(drift.x).toFixed(2) }}&deg; | Y
      {{ degrees(drift.y).toFixed(2) }}&deg;
    </span>
    <span v-else> N/A </span>
  </ConfigEntry>
</template>
