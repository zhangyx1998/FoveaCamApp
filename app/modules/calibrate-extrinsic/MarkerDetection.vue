<script setup lang="ts">
import { computed } from "vue";
import { Point2d } from "core/Geometry";
import { avg, distance2D } from "@lib/util/math";
import { combinations } from "@lib/util/iter";

const props = defineProps<{
    detection: Point2d[] & { id?: any };
    features?: Point2d[];
    color?: string;
}>();
const center = computed(() => ({
    x: avg(props.detection.map((p) => p.x)),
    y: avg(props.detection.map((p) => p.y)),
}));
const style = computed(() => {
    const style: Record<string, string> = {};
    if (props.color) {
        style["--theme"] = props.color;
    }
    return style;
});
const size = computed(() =>
    Math.max(
        ...combinations(props.detection, 2).map(([a, b]) => distance2D(a, b))
    )
);
const path = computed(
    () =>
        `M${props.detection
            .slice(0, 4)
            .map((p) => p.x + " " + p.y)
            .join("L")}Z`
);
</script>

<template>
    <g :style="style">
        <path :d="path" style="stroke: var(--theme)" :stroke-width="Math.max(2, size * 0.04)" fill="none" />
        <circle v-for="(p, i) in features ?? []" :key="i" :cx="p.x" :cy="p.y" :r="Math.max(2, size * 0.04)"
            fill="var(--theme)" stroke="black" :stroke-width="Math.max(1, size * 0.02)" />
        <text v-if="detection.id !== undefined && !features" :x="center.x" :y="center.y" :font-size="size * 0.8"
            text-anchor="middle" dominant-baseline="central" fill="var(--theme)">
            {{ detection.id }}
        </text>
    </g>
</template>
