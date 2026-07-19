<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    leftColor: string;
    rightColor: string;
    centerColor?: string;
    frameSize?: number;
    gap?: number;
    strokeWidth?: number;
  }>(),
  {
    centerColor: "white",
    frameSize: 100,
    gap: 100,
    strokeWidth: 4,
  },
);

const cornerRadius = props.strokeWidth * 1.5;

function frame(x: number) {
  const half = props.frameSize / 2;
  return {
    x: x - half,
    y: -half,
    width: props.frameSize,
    height: props.frameSize,
  };
}

function corners(x: number) {
  const { x: left, y: top, width, height } = frame(x);
  const right = left + width;
  const bottom = top + height;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

const leftCenter = -(props.frameSize + props.gap) / 2;
const rightCenter = (props.frameSize + props.gap) / 2;
</script>

<template>
  <g>
    <rect
      v-bind="frame(leftCenter)"
      fill="none"
      :stroke="leftColor"
      :stroke-width="strokeWidth"
    />
    <circle
      v-for="(p, i) in corners(leftCenter)"
      :key="`l${i}`"
      :cx="p.x"
      :cy="p.y"
      :r="cornerRadius"
      :fill="leftColor"
      stroke="black"
      :stroke-width="strokeWidth * 0.4"
    />
    <rect
      v-bind="frame(rightCenter)"
      fill="none"
      :stroke="rightColor"
      :stroke-width="strokeWidth"
    />
    <circle
      v-for="(p, i) in corners(rightCenter)"
      :key="`r${i}`"
      :cx="p.x"
      :cy="p.y"
      :r="cornerRadius"
      :fill="rightColor"
      stroke="black"
      :stroke-width="strokeWidth * 0.4"
    />
    <line
      x1="-20"
      x2="20"
      :stroke="centerColor"
      :stroke-width="strokeWidth"
    />
    <line
      y1="-20"
      y2="20"
      :stroke="centerColor"
      :stroke-width="strokeWidth"
    />
    <text
      :x="leftCenter"
      y="8"
      font-size="100"
      text-anchor="middle"
      :fill="leftColor"
    >
      L
    </text>
    <text
      :x="rightCenter"
      y="8"
      font-size="100"
      text-anchor="middle"
      :fill="rightColor"
    >
      R
    </text>
  </g>
</template>
