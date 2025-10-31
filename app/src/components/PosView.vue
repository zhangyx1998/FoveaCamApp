<script setup lang="ts">
import { Pos } from "./Controller.vue";
import { computed } from "vue";

const props = defineProps<{
    pos: Pos;
    lim?: number;
    thickness?: number;
    fontSize?: number;
    color?: string;
    unit?: string;
}>();
const color = computed(() => props.color || "white");
const lim = computed(() => props.lim || 200);
const thickness = computed(() => props.thickness || lim.value * 0.01);
const fontSize = computed(() => props.fontSize || thickness.value * 8);
const unit = computed(() => props.unit || "V");
const R = computed(() => thickness.value * 4);
function viewBox(l: number, t: number, f: number) {
    const r = l + t + f * 2;
    return [-r, -r, r * 2, r * 2].join(" ");
}

function dots() {
    const result: Pos[] = [];
    const l = lim.value;
    for (let i = -0.9; i <= 0.9; i += 0.1) {
        for (let j = -0.9; j <= 0.9; j += 0.1) {
            result.push({ x: i * l, y: j * l });
        }
    }
    return result;
}

function format(v: number, unit: string, radix: number = 1) {
    const s = Math.abs(v).toFixed(radix) + unit;
    if (v > 0) return "+" + s;
    if (v < 0) return "-" + s;
    return " " + s;
}
</script>

<template>
    <svg
        :viewBox="viewBox(lim, thickness, fontSize)"
        :style="{ '--color': color }"
    >
        <!-- Decorations -->
        <rect
            :x="-lim"
            :y="-lim"
            :width="lim * 2"
            :height="lim * 2"
            stroke="gray"
            :stroke-width="thickness"
        />
        <circle
            v-for="({ x, y }, i) in dots()"
            :key="i"
            :cx="x"
            :cy="y"
            :r="thickness / 2"
            fill="gray"
        />
        <!-- Slots -->
        <slot></slot>
        <!-- Dashed lines -->
        <line
            v-if="pos.y - R * 2 > -lim"
            :x1="pos.x"
            :y1="-lim"
            :x2="pos.x"
            :y2="pos.y - R * 2"
            stroke="var(--reactive-color)"
            stroke-dasharray="4 4"
        />
        <line
            v-if="pos.y + R * 2 < lim"
            :x1="pos.x"
            :y1="pos.y + R * 2"
            :x2="pos.x"
            :y2="lim"
            stroke="var(--reactive-color)"
            stroke-dasharray="4 4"
        />
        <line
            v-if="pos.x - R * 2 > -lim"
            :x1="-lim"
            :y1="pos.y"
            :x2="pos.x - R * 2"
            :y2="pos.y"
            stroke="var(--reactive-color)"
            stroke-dasharray="4 4"
        />
        <line
            v-if="pos.x + R * 2 < lim"
            :x1="pos.x + R * 2"
            :y1="pos.y"
            :x2="lim"
            :y2="pos.y"
            stroke="var(--reactive-color)"
            stroke-dasharray="4 4"
        />
        <!-- Position text -->
        <text
            :x="pos.x"
            :y="-lim - fontSize"
            :font-size="fontSize"
            text-anchor="middle"
            dominant-baseline="central"
            fill="var(--reactive-color)"
        >
            {{ format(pos.x, unit) }}
        </text>
        <text
            :x="pos.x"
            :y="+lim + fontSize"
            :font-size="fontSize"
            text-anchor="middle"
            dominant-baseline="central"
            fill="var(--reactive-color)"
        >
            {{ format((100 * pos.x) / lim, "%") }}
        </text>
        <text
            :x="-pos.y"
            :y="-lim - fontSize"
            :font-size="fontSize"
            text-anchor="middle"
            dominant-baseline="central"
            fill="var(--reactive-color)"
            transform="rotate(-90)"
        >
            {{ format(pos.y, unit) }}
        </text>
        <text
            :x="+pos.y"
            :y="-lim - fontSize"
            :font-size="fontSize"
            text-anchor="middle"
            dominant-baseline="central"
            fill="var(--reactive-color)"
            transform="rotate(+90)"
        >
            {{ format((100 * pos.y) / lim, "%") }}
        </text>
        <!-- Marker -->
        <circle
            :cx="pos.x"
            :cy="pos.y"
            :r="R"
            fill="var(--color)"
            stroke-width="1"
        />
    </svg>
</template>

<style scoped lang="scss">
svg {
    font-family: "Cascadia Code", "Courier New", Courier, monospace;
    --reactive-color: gray;
    &:hover,
    &:active {
        --reactive-color: var(--color);
    }
}
</style>
