<script setup lang="ts">
import { Scale } from "@lib/util/math";
import Vector from "@lib/vector";
import SetPoints from "@src/set-points";
import { computed, watch } from "vue";
const props = defineProps<{
  select?: number | null;
  points: SetPoints;
  unit?: string | Scale | (string | Scale)[];
}>();
const emit = defineEmits<{
  (e: "update:select", v: number | null): void;
  (e: "update:hover", v: number | null): void;
}>();
const error = computed(() =>
  props.points.output instanceof Error ? props.points.output : null,
);
watch(
  () => props.points.output,
  (o) => {
    const { select } = props;
    if (select && Array.isArray(o) && select in o) return;
    emit("update:select", null);
  },
);
function getUnit(i: number) {
  const { unit } = props;
  if (Array.isArray(unit)) return unit[i];
  return unit;
}
</script>

<template>
  <div
    class="fill point-list"
    v-if="Array.isArray(points.output) && points.output.length > 0"
  >
    <div
      v-for="(p, i) in points"
      class="point-entry"
      :class="{ selected: select && i === select }"
      :key="i"
      @click="emit('update:select', select !== i ? i : null)"
      @mouseenter="emit('update:hover', i)"
      @mouseleave="emit('update:hover', null)"
    >
      <pre class="sequence">{{ (i + 1).toString().padStart(2, "0") }}</pre>
      <pre class="coordinates">{{
        p.map((v, j) => Scale.pm(v, 2, getUnit(j))).join(", ")
      }}</pre>
    </div>
  </div>
  <div
    v-else-if="error"
    class="fill v-center error-message"
    style="user-select: none"
  >
    <h4 style="color: red">{{ error.name }}</h4>
    <span style="color: yellow">{{ error.message }}</span>
  </div>
  <div v-else class="fill v-center">
    <h4 style="color: gray; user-select: none">No Points Set</h4>
  </div>
</template>

<style scoped lang="scss">
.fill {
  width: 100%;
  height: 100%;
}
.v-center {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
}
.point-list {
  overflow-x: hidden;
  overflow-y: scroll;
  padding: 0.5em;
  font-size: 0.8em;
}
.point-entry {
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  overflow-x: scroll;
  opacity: 0.8;
  &:hover {
    background-color: #fff2;
  }
  &.selected {
    opacity: 1;
    background-color: #08fa;
  }
}
pre {
  margin: 0;
  font-family: inherit;
}
.sequence {
  user-select: none;
  color: #888;
  min-width: 4ch;
  text-align: right;
  padding: 0.2em 1ch;
  border-right: 1px solid #8884;
  margin-right: 1ch;
  .selected & {
    opacity: 1;
    color: #fffa;
    background-color: #08f;
    border-right: 1px solid black;
  }
}
.coordinates {
  overflow: scroll;
  .selected & {
    color: white;
  }
}
</style>
