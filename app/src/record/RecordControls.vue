<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAsyncComputed } from "@lib/util/vue";
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
watch(
  () => recording.current_path,
  (p) => {
    if (save_path.value === "") save_path.value = p;
  },
);

const path_valid = useAsyncComputed(
  () => window.foveaBridge.validateWritablePath(save_path.value),
  false,
);

// The recording is a single `<dir>/<seq>.fcap` file (no per-recording
// directory) — mirrors FOVEA_EXTENSION in @orchestrator/recorder/schema.
const FCAP_SUFFIX = ".fcap";

const resolved_seq_path = useAsyncComputed(
  () => window.foveaBridge.resolvePath(save_path.value, sequence.value),
  "",
);
const seq_valid = useAsyncComputed(
  async () =>
    resolved_seq_path.value !== "" &&
    !(await window.foveaBridge.pathExists(resolved_seq_path.value + FCAP_SUFFIX)),
  true,
);

async function start() {
  const path = save_path.value || recording.current_path;
  const full = await window.foveaBridge.resolvePath(path, sequence.value);
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
      <div class="suffix">{{ FCAP_SUFFIX }}</div>
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
  /* translucent panel wash (kept literal — no semantic token for the alpha) */
  background: #222e;
  backdrop-filter: blur(12px);
  border: 1px solid var(--tint-3);
  border-radius: 6px 6px;
  padding: 0.8em 1em;
  display: flex;
  flex-direction: column;
  gap: 0.6em;
  font-size: 0.85em;
}

.title {
  color: var(--text-muted);
  font-weight: 600;
  font-size: 0.9em;
}

.path-row {
  display: flex;
  align-items: center;
  border: 1px solid var(--tint-3);
  border-radius: 4px;
  background-color: var(--tint-1);
  padding: 0.3em 0.5em;
  font-family: var(--font-mono);
  &:focus-within {
    outline: 1px solid var(--accent-bright);
  }
  // Invalid: a single --danger signal (P2c — dropped the yellow double-signal).
  &.invalid {
    outline: 1px solid var(--danger) !important;
  }
  .directory {
    flex: 1;
    min-width: 0;
  }
  .separator,
  .suffix {
    padding: 0 0.3ch;
    color: var(--text-disabled);
  }
  .suffix {
    flex-shrink: 0;
    user-select: none;
    // Flush against the sequence — the real filename is contiguous `0001.fcap`.
    padding-left: 0;
  }
  .sequence {
    flex-shrink: 0;
  }
  .invalid,
  .invalid input {
    color: var(--danger-text);
  }
  input {
    font-family: var(--font-mono);
    font-size: 1em;
    width: 100%;
    border: none;
    background: none;
    color: var(--text);
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
  color: var(--text);
  font-weight: 600;
  font-size: 0.9em;
  cursor: pointer;
  &.green {
    background: var(--ok);
  }
  &.red {
    background: var(--danger);
  }
  &:hover:not(:disabled) {
    filter: brightness(1.2);
  }
  &:disabled {
    background-color: var(--tint-2);
    cursor: not-allowed;
    opacity: 0.5;
  }
}
</style>
