<script setup lang="ts">
import { computed } from "vue";
import type { Point, Size } from "core/Geometry";
import type { Undistort } from "core/Vision";
import { deg } from "@lib/util/math";

const props = defineProps<{
    cursor: (Point & Partial<Size>) | null;
    undistort?: Undistort | null;
    color?: string;
    box?: "rect" | "circle" | "dot";
    size?: number;
}>();

const x = computed(() => props.cursor?.x ?? 0);
const y = computed(() => props.cursor?.y ?? 0);
const w = computed(() => props.cursor?.width ?? 0);
const h = computed(() => props.cursor?.height ?? 0);
const r = computed(() => {
    const { width = 0, height = 0 } = props.cursor ?? {};
    return Math.min(width, height) * 0.01 * (props.size ?? 1);
});
const a = computed(() => {
    const { undistort: u } = props;
    if (!props.cursor || !u) return null;
    const [angle] = u.angular(u.undistort([props.cursor]));
    return {
        x: deg(angle.x),
        y: deg(angle.y),
    };
});
</script>

<template>
    <g v-if="cursor">
        <line
            v-if="x > r"
            :x1="0"
            :y1="y"
            :x2="x - r"
            :y2="y"
            :stroke="color ?? 'red'"
            :stroke-width="r * 0.2"
        />
        <line
            v-if="x + r < w"
            :x1="x + r"
            :y1="y"
            :x2="w"
            :y2="y"
            :stroke="color ?? 'red'"
            :stroke-width="r * 0.2"
        />
        <line
            v-if="y > r"
            :x1="x"
            :y1="0"
            :x2="x"
            :y2="y - r"
            :stroke="color ?? 'red'"
            :stroke-width="r * 0.2"
        />
        <line
            v-if="y + r < h"
            :x1="x"
            :y1="y + r"
            :x2="x"
            :y2="h"
            :stroke="color ?? 'red'"
            :stroke-width="r * 0.2"
        />
        <template v-if="a">
            <text
                :x="x < w / 2 ? x + r * 2 : x - r * 2"
                :y="r"
                :fill="color ?? 'red'"
                :font-size="r * 3"
                :text-anchor="x < w / 2 ? 'start' : 'end'"
                dominant-baseline="hanging"
                >{{ a.x.toFixed(2) }} deg</text
            >
            <text
                :x="r"
                :y="y < h / 2 ? y + r * 2 : y - r * 2"
                :fill="color ?? 'red'"
                :font-size="r * 3"
                text-anchor="start"
                :dominant-baseline="y < h / 2 ? 'hanging' : 'bottom'"
                >{{ a.y.toFixed(2) }} deg</text
            >
        </template>
        <rect
            v-if="box === 'rect'"
            :x="x - r * 2"
            :y="y - r * 2"
            :width="r * 4"
            :height="r * 4"
            :stroke="color ?? 'red'"
            :stroke-width="r * 0.2"
            fill="none"
        />
        <circle
            v-if="box === 'circle'"
            :cx="x"
            :cy="y"
            :r="r * 2"
            :stroke="color ?? 'red'"
            :stroke-width="r * 0.2"
            fill="none"
        />
        <circle
            v-if="box === 'dot'"
            :cx="x"
            :cy="y"
            :r="r * 0.6"
            :fill="color ?? 'red'"
        />
    </g>
</template>
