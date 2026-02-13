<script setup lang="ts">
defineProps<{
  cx?: number | string;
  cy?: number | string;
  weight?: number | string;
  color?: string;
}>();
</script>

<template>
  <line
    x1="-50vw"
    y1="0"
    :x2="cx ? '-' + cx : 0"
    y2="0"
    :stroke="color ?? 'white'"
    :stroke-width="weight ?? '1'"
  />
  <line
    x1="50vw"
    y1="0"
    :x2="cx ? cx : 0"
    y2="0"
    :stroke="color ?? 'white'"
    :stroke-width="weight ?? '1'"
  />
  <line
    x1="0"
    y1="-50vh"
    x2="0"
    :y2="cy ? '-' + cy : 0"
    :stroke="color ?? 'white'"
    :stroke-width="weight ?? '1'"
  />
  <line
    x1="0"
    y1="50vh"
    x2="0"
    :y2="cy ? cy : 0"
    :stroke="color ?? 'white'"
    :stroke-width="weight ?? '1'"
  />
</template>
