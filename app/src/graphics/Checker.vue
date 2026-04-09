<script setup lang="ts">
import { computed } from "vue";

const props = defineProps({
  M: {
    type: Number,
    default: 6,
  },
  N: {
    type: Number,
    default: undefined,
  },
  size: {
    type: Number,
    default: 10, // mm
  },
  invert: {
    type: Boolean,
    default: false,
  },
});

const pattern = computed(() => {
  const { size: mm, M, N = M } = props;
  const blacks: any[] = [];
  const x0 = (M + 1) * mm * -0.5;
  const y0 = ((N ?? M) + 1) * mm * -0.5;
  for (let y = 0; y <= N; y++)
    for (let x = 0; x <= M; x++)
      if ((x + y) % 2 === 0)
        blacks.push({
          x: x0 + x * mm,
          y: y0 + y * mm,
          width: mm + "px",
          height: mm + "px",
        });
  return blacks;
});
</script>

<template>
  <rect
    x="-50vw"
    y="-50vh"
    width="100vw"
    height="100vh"
    :fill="invert ? 'black' : 'white'"
  />
  <rect
    v-for="(p, i) in pattern"
    :key="i"
    v-bind="p"
    :fill="invert ? 'white' : 'black'"
  />
</template>
