<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";

const props = defineProps({
  modelValue: {
    type: Number,
    required: true,
  },
  min: {
    type: Number,
    required: false,
    default: 0,
  },
  max: {
    type: Number,
    required: false,
    default: 100,
  },
  step: {
    type: Number,
    required: false,
    default: 1,
  },
  neutral: {
    type: Number,
    required: false,
    default: 0,
  },
  disabled: {
    type: Boolean,
    required: false,
    default: false,
  },
  clamp: {
    type: Boolean,
    required: false,
    default: true,
  },
  color: {
    type: String,
    required: false,
    default: "currentColor",
  },
});
const emit = defineEmits(["update:modelValue"]);
const element = useTemplateRef<HTMLLabelElement>("el");

function ratioOf(value: number) {
  const { min: l, max: r } = props;
  if (r === l) return 0.5;
  return (value - l) / (r - l);
}

const cursorStyle = computed(() => {
  return {
    left: `${ratioOf(props.modelValue) * 100}%`,
  };
});

const infillStyle = computed(() => {
  const a = ratioOf(props.modelValue);
  const b = ratioOf(props.neutral);
  const l = Math.min(a, b);
  const r = Math.max(a, b);
  return {
    left: `${l * 100}%`,
    right: `${(1 - r) * 100}%`,
  };
});

function clamp(value: number) {
  if (!props.clamp) return value;
  const { min: l, max: r } = props;
  const [a, b] = [Math.min(l, r), Math.max(l, r)];
  return Math.max(a, Math.min(b, value));
}

const drag = ref(false);
function trackUntilRelease(e: MouseEvent) {
  if (!(e.buttons & 1)) {
    drag.value = false;
    window.removeEventListener("mousemove", trackUntilRelease);
    return;
  }
  // Compute position
  const el = element.value;
  if (!el) return console.warn("No label element found");
  const { min: l, max: r } = props;
  const rect = el.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  emit("update:modelValue", clamp(l + ratio * (r - l)));
}

function track(e: MouseEvent) {
  drag.value = true;
  window.addEventListener("mousemove", trackUntilRelease);
  trackUntilRelease(e);
}

function increment(delta: number) {
  const { modelValue, step, min: l, max: r } = props;
  delta *= Math.abs(step) * (Math.sign(r - l) || 1);
  emit("update:modelValue", clamp(modelValue + delta));
}

function handleKeydown(e: KeyboardEvent) {
  const modifiers = [e.ctrlKey, e.metaKey, e.altKey, e.shiftKey];
  const scale = modifiers.reduce((a, b) => a * (b ? 0.1 : 1), 1);
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowDown":
      e.preventDefault();
      increment(-1 * scale);
      break;
    case "ArrowRight":
    case "ArrowUp":
      e.preventDefault();
      increment(1 * scale);
      break;
  }
}
</script>

<template>
  <label
    ref="el"
    class="range-slider"
    :style="{ color }"
    :tabindex="disabled ? -1 : 0"
    @mousedown="track"
    @keydown="handleKeydown"
    :disabled="disabled"
  >
    <div class="intent">
      <slot></slot>
      <div class="infill" :style="infillStyle"></div>
    </div>
    <div class="cursor" :style="cursorStyle"></div>
  </label>
</template>

<style lang="scss" scoped>
label.range-slider {
  position: relative;
  width: 100%;
  height: 2em;
  border-radius: 4px;
  opacity: 0.8;
  background-color: #fff2;
  outline: 1px solid #fff4;
  cursor: ew-resize;
  user-select: none;
  margin-top: calc(1ch + 8px);
  margin-bottom: calc(1ch + 8px);
  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    filter: grayscale(0.5);
  }
  &:hover,
  &:active,
  &:focus {
    opacity: 1;
  }
  &:active,
  &:focus {
    outline: 2px solid var(--theme, #08c);
  }
  .intent {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: 4px;
    overflow: hidden;
    padding: 0 1ch;
    pointer-events: none;
  }
  .infill,
  .cursor {
    position: absolute;
    top: 0;
    bottom: 0;
    pointer-events: none;
    background-color: currentColor;
  }
  .cursor {
    transform: translateX(-50%);
    // Triangles above and below the slider body (outside)
    &::before,
    &::after {
      content: "";
      position: absolute;
      display: block;
      width: 0;
      height: 0;
      background: none;
      border: 1ch solid transparent;
      left: -1ch;
      transition: 0.1s ease;
      opacity: 0;
      --offset: -2ch;
    }
    &::before {
      top: calc(var(--offset) - 4px);
      border-top-color: currentColor;
    }
    &::after {
      bottom: calc(var(--offset) - 4px);
      border-bottom-color: currentColor;
    }
  }
  &:hover,
  &:active,
  &:focus {
    .cursor::before,
    .cursor::after {
      opacity: 1;
      --offset: -1ch;
    }
  }
  .infill {
    mix-blend-mode: exclusion;
  }
}
</style>
