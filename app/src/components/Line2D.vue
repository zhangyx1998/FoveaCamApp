<script setup lang="ts">
import type { Point2d } from "core/Geometry";
import { computed, FunctionalComponent, h } from "vue";

type MarkerType = "." | "x" | "+" | "o";

const props = defineProps<{
  data: Point2d[];
  color?: string;
  lineColor?: string | null;
  marker?: MarkerType | null;
  markerSize?: number;
  lineWidth?: number;
  focus?: number | null;
  focusColor?: string;
}>();

const path = computed(() => {
  let D = "";
  for (const { x, y } of props.data) {
    D += D ? ` L ${x} ${y}` : `M ${x} ${y}`;
  }
  return D;
});

const m = computed(() =>
  props.marker === null ? null : (props.marker ?? "."),
);
const r = computed(() => props.markerSize ?? 4);
const t = computed(() => props.lineWidth ?? 2);
const c = computed(() => props.color ?? "white");

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
  <g>
    <path
      v-if="lineColor !== null"
      :d="path"
      :stroke="lineColor ?? c"
      :stroke-width="t"
      fill="none"
      opacity="0.5"
    ></path>
    <Marker
      v-if="m !== null"
      v-for="(p, i) in data"
      :key="i"
      :p="p"
      :m="m"
      :s="r"
      :c="c"
    />
    <circle
      v-if="typeof focus === 'number' && data[focus]"
      :cx="data[focus].x"
      :cy="data[focus].y"
      :r="r + t * 2"
      :stroke="focusColor ?? c"
      :stroke-width="t"
      fill="none"
    />
  </g>
</template>
