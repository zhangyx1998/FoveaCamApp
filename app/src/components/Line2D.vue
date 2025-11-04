<script setup lang="ts">
import type { Point2d } from "core";
import { computed, FunctionalComponent, h } from "vue";

type MarkerType = "." | "x" | "+" | "o";

const props = defineProps<{
    data: Point2d[];
    color?: string;
    marker?: MarkerType;
    markerSize?: number;
    lineWidth?: number;
}>();

const path = computed(() => {
    let D = "";
    for (const { x, y } of props.data) {
        D += D ? ` L ${x} ${y}` : `M ${x} ${y}`;
    }
    return D;
});

const Marker: FunctionalComponent<{
    p: Point2d;
    m: MarkerType;
    s: number;
    c: string;
}> = ({ p, m, s, c }, _: any) => {
    if (!m) return null;
    switch (m) {
        case ".":
            return h("circle", {
                cx: p.x,
                cy: p.y,
                r: s,
                fill: c,
            });
        case "x":
            return h("g", [
                h("line", {
                    x1: p.x - s,
                    y1: p.y - s,
                    x2: p.x + s,
                    y2: p.y + s,
                    stroke: c,
                    "stroke-width": 2,
                }),
                h("line", {
                    x1: p.x - s,
                    y1: p.y + s,
                    x2: p.x + s,
                    y2: p.y - s,
                    stroke: c,
                    "stroke-width": 2,
                }),
            ]);
        case "+":
            return h("g", [
                h("line", {
                    x1: p.x - s,
                    y1: p.y,
                    x2: p.x + s,
                    y2: p.y,
                    stroke: c,
                    "stroke-width": 2,
                }),
                h("line", {
                    x1: p.x,
                    y1: p.y - s,

                    x2: p.x,
                    y2: p.y + s,
                    stroke: c,
                    "stroke-width": 2,
                }),
            ]);
        case "o":
            return h("circle", {
                cx: p.x,
                cy: p.y,
                r: s,
                fill: "none",
                stroke: c,
                "stroke-width": 2,
            });
        default:
            return null;
    }
};
</script>

<template>
    <path
        :d="path"
        :stroke="props.color ?? 'white'"
        :stroke-width="props.lineWidth ?? 2"
        fill="none"
    ></path>
    <Marker
        v-if="marker"
        v-for="(p, i) in data"
        :key="i"
        :p="p"
        :m="marker"
        :s="markerSize ?? 4"
        :c="color ?? 'white'"
    />
</template>
