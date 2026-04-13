<script setup lang="ts">
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { computed, ref, watch } from "vue";
import { validateWritablePath } from "@lib/util/fs";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faCircle, faXmark } from "@fortawesome/free-solid-svg-icons";
import { current_recording } from ".";

const emit = defineEmits(["exit"]);

if (!current_recording.value)
  throw new Error("RecordControls requires an active Recording context");

const recording = current_recording.value;

const sequence_element = ref<HTMLInputElement | null>(null);
watch(sequence_element, (el) => el?.focus());

const sequence_override = ref<string | null>(null);
const sequence = computed({
  get() {
    return sequence_override.value ?? recording.sequence;
  },
  set(val) {
    sequence_override.value = val;
  },
});

const save_path = ref(recording.current_path);

const path_valid = computed(() => validateWritablePath(save_path.value));

const seq_valid = computed(() => {
  const path = resolve(save_path.value, sequence.value);
  return !existsSync(path);
});

async function start() {
  const path = save_path.value || recording.current_path;
  const full = resolve(path, sequence.value);
  await recording.start(full);
  recording.updateSequence(sequence.value);
  recording.current_path = path;
  emit("exit");
}
</script>

<template>
  <div class="record-popup" @keydown.enter="start">
    <div class="title">Select Recording Destination</div>
    <div class="path-row" :class="{ invalid: !(path_valid && seq_valid) }">
      <div class="directory" :class="{ invalid: !path_valid }">
        <input
          type="text"
          v-model="save_path"
          placeholder="Save directory..."
          style="min-width: 40ch"
        />
      </div>
      <div class="separator">/</div>
      <div class="sequence" :class="{ invalid: !seq_valid }">
        <input
          type="text"
          v-model="sequence"
          ref="sequence_element"
          :style="{ width: Math.max(sequence.length, 6) + 'ch' }"
        />
      </div>
    </div>
    <div class="buttons">
      <button
        @click="start"
        class="action green"
        :disabled="!path_valid || !seq_valid"
      >
        <Icon :icon="faCircle" /> <span>Start</span>
      </button>
      <button @click="emit('exit')" class="action red">
        <Icon :icon="faXmark" /> <span>Cancel</span>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.record-popup {
  position: absolute;
  top: 10px;
  right: 10px;
  min-width: 70ch;
  max-width: 120ch;
  background: #222e;
  backdrop-filter: blur(12px);
  border: 1px solid #fff3;
  border-radius: 6px 6px;
  padding: 0.8em 1em;
  display: flex;
  flex-direction: column;
  gap: 0.6em;
  font-size: 0.85em;
}

.title {
  color: #aaa;
  font-weight: 600;
  font-size: 0.9em;
}

.path-row {
  display: flex;
  align-items: center;
  border: 1px solid #fff3;
  border-radius: 4px;
  background-color: #fff1;
  padding: 0.3em 0.5em;
  font-family: monospace;
  &:focus-within {
    outline: 1px solid #0af;
  }
  &.invalid {
    outline: 1px solid red !important;
  }
  .directory {
    flex: 1;
    min-width: 0;
  }
  .separator {
    padding: 0 0.3ch;
    color: #666;
  }
  .sequence {
    flex-shrink: 0;
  }
  .invalid,
  .invalid input {
    color: #ff0;
  }
  input {
    font-family: monospace;
    font-size: 1em;
    width: 100%;
    border: none;
    background: none;
    color: white;
    outline: none;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.buttons {
  display: flex;
  gap: 0.6em;
  justify-content: flex-end;
}

button.action {
  display: flex;
  gap: 0.6ch;
  align-items: center;
  padding: 0.4em 0.8em;
  border: none;
  border-radius: 4px;
  color: white;
  font-weight: 600;
  font-size: 0.9em;
  cursor: pointer;
  &.green {
    background: #080;
  }
  &.red {
    background: #a00;
  }
  &:hover:not(:disabled) {
    filter: brightness(1.2);
  }
  &:disabled {
    background-color: #fff2;
    cursor: not-allowed;
    opacity: 0.5;
  }
}
</style>
