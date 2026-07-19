<script setup lang="ts" generic="T extends string | number">
// A reusable single-choice control — a vertical segmented list of exclusive
// options, each showing a label and an optional one-line hint. Unlike the
// inline, text-styled `InlineSelect` (a native <select> that reads as inline
// text, for compact title-bar pickers), this is a proper drawer/panel control:
// the current choice is always visible, options can carry hints, and it is
// keyboard-operable (arrow keys cycle, focus ring on the group).
//
// Interaction principles: INSTANT (selection applies on click, no confirm),
// SNAP (short color transition only — the active border
// is always present so nothing reflows), LAYOUT-STABLE (the selected/idle
// states differ only in color, never in box size).
//
//   <SingleSelect
//     v-model="choice"
//     :options="[{ value: 'a', label: 'Option A', hint: 'what it does' }]"
//   />
import { computed } from "vue";

export interface SingleSelectOption<V extends string | number> {
  value: V;
  label: string;
  /** One-line description shown under the label. */
  hint?: string;
  /** Native tooltip on the option. */
  title?: string;
  /** Disable just this option (the group can still hold another value). */
  disabled?: boolean;
}

const props = defineProps<{
  options: readonly SingleSelectOption<T>[];
  disabled?: boolean;
}>();
const model = defineModel<T>({ required: true });

const isDisabled = computed(() => props.disabled ?? false);

function pick(o: SingleSelectOption<T>): void {
  if (isDisabled.value || o.disabled) return;
  if (model.value !== o.value) model.value = o.value;
}

function onKeydown(e: KeyboardEvent): void {
  if (isDisabled.value) return;
  const enabled = props.options.filter((o) => !o.disabled);
  if (enabled.length === 0) return;
  const idx = enabled.findIndex((o) => o.value === model.value);
  let next: number;
  switch (e.key) {
    case "ArrowDown":
    case "ArrowRight":
      next = idx < 0 ? 0 : (idx + 1) % enabled.length;
      break;
    case "ArrowUp":
    case "ArrowLeft":
      next = idx <= 0 ? enabled.length - 1 : idx - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  model.value = enabled[next].value;
}
</script>

<template>
  <!-- Roving tabindex (proper radiogroup semantics):
       ONE tab stop — the selected option — and arrows move within; the group
       div itself is not tabbable (it only hosts the keydown handler). -->
  <div
    class="single-select"
    role="radiogroup"
    :aria-disabled="isDisabled"
    @keydown="onKeydown"
  >
    <button
      v-for="o in options"
      :key="String(o.value)"
      type="button"
      class="option"
      role="radio"
      :class="{ active: model === o.value }"
      :aria-checked="model === o.value"
      :tabindex="model === o.value && !isDisabled ? 0 : -1"
      :disabled="isDisabled || o.disabled"
      :title="o.title"
      @click="pick(o)"
    >
      <span class="label">{{ o.label }}</span>
      <span v-if="o.hint" class="hint">{{ o.hint }}</span>
    </button>
  </div>
</template>

<style scoped lang="scss">
.single-select {
  display: flex;
  flex-direction: column;
  gap: 0.35em;
  outline: none;
  border-radius: 5px;

  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  &[aria-disabled="true"] {
    opacity: 0.5;
    filter: grayscale(0.5);
  }

  .option {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15em;
    width: 100%;
    text-align: left;
    padding: 0.4em 0.6em;
    // Border is ALWAYS present (transparent → accent on active) so selecting
    // never changes the box size (layout-stable).
    border: 1px solid var(--tint-3);
    border-radius: 4px;
    background: var(--tint-1);
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition:
      background-color 0.1s ease,
      border-color 0.1s ease;

    &:hover:not(:disabled) {
      background: var(--tint-2);
    }

    &:active:not(:disabled) {
      background: var(--tint-3);
    }

    &.active {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 18%, transparent);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .label {
      font-weight: 600;
      font-size: 0.9em;
    }

    .hint {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      line-height: 1.25;
    }
  }
}
</style>
