<script setup lang="ts">
import { MarkerDetector, PreDefinedDictionary } from "core/Vision";
import { computed } from "vue";

const props = defineProps<{
  id: number;
  cx?: number;
  cy?: number;
  size?: number;
  outline?: number;
  dictionary?: PreDefinedDictionary;
}>();

const detector = computed(
  () => new MarkerDetector(props.dictionary ?? "4X4_50"),
);

const pattern = computed(() => detector.value.pattern(props.id));

const size = computed(() => props.size ?? 60);
const grid_size = computed(() => size.value / (pattern.value.length + 2));
const outline = computed(() => props.outline ?? grid_size.value);

const blocks = computed(() => {
  const p = pattern.value;
  console.log("Marker pattern:", p);
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
