<script setup lang="ts">
import { computed } from "vue";
import { MARKER_PATTERNS } from "@lib/marker-patterns.generated";

// Static bit-grid lookup (docs/history/refactor/orchestrator.md §7.1 Stage 3 T1) —
// this was the last renderer-reachable `core` dependency: drawing a marker
// only needs its dictionary's fixed pattern data, not a live
// `core/Vision` `MarkerDetector`. Regenerate `MARKER_PATTERNS` (`app/
// scripts/gen-marker-patterns.cjs`) to add a dictionary beyond "4X4_50".

const props = defineProps<{
  id: number;
  cx?: number;
  cy?: number;
  size?: number;
  outline?: number;
  dictionary?: string;
}>();

const pattern = computed(() => {
  const dict = MARKER_PATTERNS[props.dictionary ?? "4X4_50"];
  const p = dict?.[props.id];
  if (!p) {
    console.warn(
      `[Marker] no static pattern for dictionary=${props.dictionary ?? "4X4_50"} id=${props.id} — regenerate marker-patterns.generated.ts if this dictionary is now in use`,
    );
    return [];
  }
  return p;
});

const size = computed(() => props.size ?? 60);
const grid_size = computed(() => size.value / (pattern.value.length + 2));
const outline = computed(() => props.outline ?? grid_size.value);

const blocks = computed(() => {
  const p = pattern.value;
  const s = size.value;
  const whites: { x: number; y: number; width: number; height: number }[] = [];
  const n = p.length;
  const d = s / (n + 2);
  let y = d - s / 2;
  for (const row of p) {
    let x = d - s / 2;
    for (const cell of row) {
      if (cell) {
        whites.push({ x, y, width: d, height: d });
      }
      x += d;
    }
    y += d;
  }
  return whites;
});

function translate(x: number, y: number) {
  return `translate(${x} ${y})`;
}
</script>

<template>
  <g :transform="translate(cx ?? 0, cy ?? 0)">
    <rect
      v-if="outline"
      :x="-(size / 2) - outline"
      :y="-(size / 2) - outline"
      :width="size + 2 * outline"
      :height="size + 2 * outline"
      :rx="outline"
      fill="white"
    />
    <rect
      :x="-(size / 2)"
      :y="-(size / 2)"
      :width="size"
      :height="size"
      fill="black"
    />
    <rect v-for="(block, i) in blocks" :key="i" v-bind="block" fill="white" />
  </g>
</template>
