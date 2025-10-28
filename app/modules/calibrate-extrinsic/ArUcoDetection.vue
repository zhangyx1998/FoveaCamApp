<script setup lang="ts">
import { computed } from 'vue';
import type { ArUcoDetectResult } from 'core';
import { diff, avg } from '@lib/util/math';
const props = defineProps<{
    detection: ArUcoDetectResult;
    color?: string;
}>();
const center = computed(() => ({
    x: avg(...props.detection.map(p => p.x)),
    y: avg(...props.detection.map(p => p.y)),
}));
const style = computed(() => {
    const style: Record<string, string> = {};
    if (props.color) {
        style['--theme'] = props.color;
    }
    return style;
});
const size = computed(() => Math.min(
    diff(...props.detection.map(p => p.x)),
    diff(...props.detection.map(p => p.y))
));
const path = computed(() => `M${props.detection.map(p => p.x + ' ' + p.y).join('L')}Z`);
</script>

<template>
    <g :style="style">
        <path :d="path" style="stroke: var(--theme)" :stroke-width="Math.max(2, size * 0.04)" fill="none" />
        <text :x="center.x" :y="center.y" style="fill: var(--theme);" :font-size="size * 0.8" text-anchor="middle"
            dominant-baseline="central">{{ detection.id }}</text>
    </g>
</template>
