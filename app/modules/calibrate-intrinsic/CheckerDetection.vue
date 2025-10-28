<script setup lang="ts">
import { computed } from "vue";
import type { Point } from "core";
const props = defineProps<{
    detection: Point[];
}>();

function rainbow(i: number, total: number) {
    return {
        fill: `hsl(${(i / total) * 360}, 100%, 50%)`,
        stroke: `white`,
        "stroke-width": size.value * 0.006,
    };
}

function distance(a: Point, b: Point) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

const size = computed(() =>
    props.detection.length >= 2
        ? distance(props.detection.at(0)!, props.detection.at(-1)!)
        : 10
);

const path = computed(
    () => `M${props.detection.map((p) => p.x + " " + p.y).join("L")}Z`
);
</script>

<template>
    <g>
        <circle
            v-for="(p, i) in detection"
            :key="i"
            :cx="p.x"
            :cy="p.y"
            :r="Math.max(2, size * 0.02)"
            v-bind="rainbow(i, detection.length)"
        />
    </g>
</template>
