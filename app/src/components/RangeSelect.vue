<script setup lang="ts">
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faArrowLeft as LArrow,
  faArrowRight as RArrow,
} from "@fortawesome/free-solid-svg-icons";
const props = defineProps({
  modelValue: {
    type: Number,
    required: true,
  },
  count: {
    type: Number,
    default: Infinity,
  },
});
const emit = defineEmits(["update:modelValue"]);
function update(value: number) {
  const { count } = props;
  value %= props.count || Infinity;
  while (value < 0) {
    if (count === Infinity || count <= 0) break;
    value += props.count;
  }
  emit("update:modelValue", Math.max(0, value));
}
</script>
<template>
  <div
    class="range-select"
    @keydown.left="update(modelValue - 1)"
    @keydown.up="update(modelValue - 1)"
    @keydown.right="update(modelValue + 1)"
    @keydown.down="update(modelValue + 1)"
  >
    <button class="arrow">
      <Icon :icon="LArrow" @click="update(modelValue - 1)" />
    </button>
    <span class="label"><input :value="modelValue + 1" /> / {{ count }}</span>
    <button class="arrow">
      <Icon :icon="RArrow" @click="update(modelValue + 1)" />
    </button>
  </div>
</template>

<style lang="scss" scoped>
.range-select {
  display: inline-flex;
  align-items: center;
  .arrow {
    background: none;
    border: none;
    color: currentColor;
    padding: 0.25em;
    cursor: pointer;
    &:hover {
      filter: brightness(1.2);
    }
    &:active {
      filter: brightness(0.8);
    }
  }
  .label {
    margin: 0 0.5em;
    font-size: 0.9em;
    input {
      width: 3ch;
      text-align: center;
      font-size: inherit;
      font-family: inherit;
      color: currentColor;
      background: none;
      border: 1px solid currentColor;
      border-radius: 4px;
      padding: 0.1em;
      &:focus {
        outline: 2px solid var(--theme, #08c);
      }
    }
  }
}
</style>
