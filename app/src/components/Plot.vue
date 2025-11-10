<script setup lang="ts">
import type { Rect } from "core/Geometry";
defineProps<{ box: Rect }>();
</script>

<template>
    <svg :viewBox="`${box.x} ${box.y} ${box.width} ${box.height}`">
        <slot></slot>
    </svg>
</template>
