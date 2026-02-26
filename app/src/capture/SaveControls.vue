<script setup lang="ts">
import { resolve } from "node:path";
import {
  existsSync,
  statSync,
  accessSync,
  constants as fs_flags,
} from "node:fs";
import { computed, ref, watch } from "vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faSave, faTrash } from "@fortawesome/free-solid-svg-icons";
import Capture from ".";
const props = defineProps({
  capture: {
    type: Capture,
    required: true,
  },
  data_ready: {
    type: Boolean,
    default: false,
  },
  save_state: {
    type: Boolean,
    default: false,
  },
});
const emit = defineEmits<{
  save: [path: string, img_format: string];
  exit: [];
}>();
const sequence_element = ref<HTMLInputElement | null>(null);
watch(sequence_element, (el) => el?.focus());

const sequence_override = ref<string | null>(null);
const sequence = computed({
  get() {
    return sequence_override.value ?? props.capture.sequence;
  },
  set(val) {
    sequence_override.value = val;
  },
});
const img_format = ref("png");

const save_path = ref(props.capture.current_path);

function validatePath(path: string) {
  if (path.trim() === "") return false;
  try {
    if (!existsSync(path)) {
      const parent = resolve(path, "..");
      if (parent === path) return false;
      return validatePath(parent);
    }
    const stats = statSync(path);
    // Path must be a directory
    if (!stats.isDirectory()) return false;
    // Check for ownership and write permission
    // throws if the path is not accessible or writable
    accessSync(path, fs_flags.W_OK);
    return true;
  } catch {
    return false;
  }
}

const path_valid = computed(() => validatePath(save_path.value));

const seq_valid = computed(() => {
  const path = resolve(save_path.value, sequence.value);
  return !existsSync(path);
});

function save() {
  const path = save_path.value || props.capture.current_path;
  emit("save", resolve(path, sequence.value), img_format.value);
  props.capture.updateSequence(sequence.value);
  props.capture.current_path = path;
}
</script>

<template>
  <div class="save-controls">
    Save As
    <div
      class="path-select"
      :class="{ invalid: !(path_valid && seq_valid) }"
      @keydown.enter="save"
    >
      <div
        class="directory"
        :class="{ invalid: !path_valid }"
        :style="{
          maxWidth: save_path.length + 'ch',
        }"
      >
        <input
          type="text"
          v-model="save_path"
          placeholder="Select save directory..."
          :disabled="save_state"
        />
      </div>
      <div style="padding: 0.5ch">/</div>
      <div class="sequence" :class="{ invalid: !seq_valid }">
        <input
          type="text"
          v-model="sequence"
          ref="sequence_element"
          :disabled="save_state"
          :style="{
            width: sequence.length + 'ch',
          }"
        />
      </div>
    </div>
    <div class="divider"></div>
    <div class="format-select">
      <label>
        Image Format:
        <select v-model="img_format" :disabled="!save_state">
          <option value="png">PNG</option>
          <option value="jpg">JPG</option>
          <option value="bmp">BMP</option>
          <option value="tiff">TIFF</option>
        </select>
      </label>
    </div>
    <div class="divider"></div>
    <button
      @click="save"
      class="action green"
      :disabled="!data_ready || !path_valid || !seq_valid || save_state"
    >
      <Icon :icon="faSave" /> <span>Save</span>
    </button>
    <button @click="emit('exit')" class="action red" :disabled="save_state">
      <Icon :icon="faTrash" /> <span>Discard</span>
    </button>
  </div>
</template>

<style lang="scss">
.save-controls {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  gap: 1em;
  padding: 0 1rem;
  border-radius: 8px;
  justify-content: space-evenly;
  border-bottom: 1px solid #fff4;
  &,
  & > * {
    flex-direction: row;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    overflow: hidden;
  }
  .divider {
    height: 100%;
    width: 1px;
    background-color: #fff4;
  }
}

.path-select {
  display: flex;
  border: 1px solid #fff3;
  border-radius: 4px;
  background-color: #fff1;
  flex-grow: 1;
  padding: 0.2em 0.5em;
  &:focus-within {
    outline: 1px solid #0af;
  }
  &.invalid {
    outline: 1px solid red !important;
  }
  * {
    font-family: monospace;
  }
  & > * {
    padding: 0;
    margin: 0;
    font-size: 0.8em;
    color: white;
    &.directory {
      flex-grow: 1;
    }
    &.invalid,
    &.invalid * {
      color: #ff0;
      opacity: 1;
    }
    &:not(.invalid):not(:focus):not(:focus-within):not(:hover) {
      opacity: 0.8;
    }
  }
  & > * > * {
    width: 100%;
    padding: 0;
    margin: 0;
  }
  input[type="text"] {
    font-size: 1em;
    border-radius: 0;
    width: 100%;
    border: none;
    background: none;
    color: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    outline: none;
  }
}

.path-input::placeholder {
  color: #fff8;
}

.browse-btn {
  padding: 0.5em;
  border: 1px solid #fff3;
  background-color: #fff2;
  color: white;
  cursor: pointer;
  transition: background-color 0.2s;
}

.browse-btn:hover {
  background-color: #fff3;
}

.format-select {
  display: flex;
  align-items: center;
  gap: 0.5em;
}

.format-select label {
  color: white;
}

.format-select select {
  padding: 0.5em;
  border: 1px solid #fff3;
  border-radius: 4px;
  background-color: #fff1;
  color: white;
  cursor: pointer;
}

button.action {
  display: flex;
  gap: 1ch;
  align-items: center;
  padding: 0.6em 0.8em;
  border: none;
  border-radius: 4px;
  color: white;
  font-weight: 600;
  transition: background-color 0.2s;
  &.green {
    background: #080;
  }
  &.red {
    background: #a00;
  }
}

button.action:hover:not(:disabled) {
  filter: brightness(1.2);
}

button.action:disabled {
  background-color: #fff2;
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
