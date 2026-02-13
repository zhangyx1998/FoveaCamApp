<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->

<script lang="ts">
import { shallowRef, type Component } from "vue";
interface OverlayItem {
  overlay: Component;
}
export const overlay = shallowRef<OverlayItem | null>(null);
export function dialog(item: OverlayItem) {
  overlay.value = item;
}
</script>

<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ overlay: Component; disabled?: boolean }>();
const active = computed(() => overlay.value === props);
function toggle() {
  if (active.value) {
    overlay.value = null;
  } else {
    overlay.value = props;
  }
}
const disabled = computed(() => {
  if (overlay.value === props) return false;
  return Boolean(props.disabled);
});
</script>

<template>
  <button
    class="overlay-toggle"
    :class="{ active }"
    @click="toggle"
    :disabled="disabled"
  >
    <slot></slot>
  </button>
</template>

<style scoped lang="scss">
button {
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  cursor: pointer;
  color: inherit;
  border-radius: 4px;
  transition: all 0.1s;
  padding: 0.4em;
  outline: 1px solid transparent;

  &.active {
    outline: 2px solid #3af;
  }

  &:hover {
    background: #fff1;
  }

  &:not(.active):not(:disabled):hover {
    outline: 1px solid #666;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}
</style>
