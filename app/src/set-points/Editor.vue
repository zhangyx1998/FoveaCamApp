<script setup lang="ts">
import SetPoints from "@src/set-points";
import { computed } from "vue";
const props = defineProps<{
  points: SetPoints;
}>();
const error = computed(() =>
  props.points.output instanceof Error ? props.points.output : null,
);
</script>

<template>
  <textarea v-model="points.raw" :class="{ error }"></textarea>
</template>

<style scoped lang="scss">
textarea {
  display: block;
  position: absolute;
  left: 2px;
  top: 2px;
  bottom: 2px;
  right: 2px;
  padding: 1ch;
  line-height: 1.6em;
  overflow: scroll;
  color: inherit;
  font-family: inherit;
  background: none;
  border-radius: 0;
  border: none;
  resize: none;
  &:focus {
    outline: 2px solid #08f;
    &.error {
      outline: 2px solid #ff0;
    }
  }
  &.error {
    outline: 2px solid #f00;
  }
}
</style>
