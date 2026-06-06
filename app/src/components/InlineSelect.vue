<script setup lang="ts" generic="T extends string | number">
// An inline, text-styled <select>. Renders like surrounding text with a small
// triangle affordance before it (pointing left when idle, down when the picker
// is open). The native picker still opens on click. Pass <option> children
// through the default slot, e.g.:
//   <InlineSelect v-model="view">
//     <option value="sliced">Sliced</option>
//   </InlineSelect>
import { ref } from "vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faCaretRight, faCaretDown } from "@fortawesome/free-solid-svg-icons";

const model = defineModel<T>();
const active = ref(false);
const select = ref<HTMLSelectElement>();

// Make the whole span interactive: a click anywhere opens the native picker.
// Clicks landing directly on the <select> are left to its native behavior to
// avoid double-toggling.
function open(e: MouseEvent) {
  if (e.target === select.value) return;
  try {
    select.value?.showPicker();
  } catch {
    select.value?.focus();
  }
}
</script>

<template>
  <span class="inline-select" @click="open">
    <Icon
      class="affordance"
      :icon="active ? faCaretDown : faCaretRight"
      aria-hidden="true"
    />
    <select
      ref="select"
      v-model="model"
      @focus="active = true"
      @blur="active = false"
    >
      <slot />
    </select>
  </span>
</template>

<style scoped lang="scss">
.inline-select {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  padding: 0 1ch 0 0.5ch;
  border-radius: 0.4em;
  transition: background-color 0.1s ease;

  &:hover {
    background-color: color-mix(in srgb, currentColor 20%, transparent);
  }

  .affordance {
    pointer-events: none;
    margin-right: 0.4ch;
    font-size: 0.75em;
    opacity: 0.6;
    transition: opacity 0.1s ease;
  }

  &:hover .affordance {
    opacity: 1;
  }

  select {
    appearance: none;
    -webkit-appearance: none;
    background: none;
    border: none;
    outline: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0;
    margin: 0;
    text-align: left;
    // Sized to the selected option's text so it reads as inline text.
    width: auto;
  }
}
</style>
