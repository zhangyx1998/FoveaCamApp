<script setup lang="ts">
import { resolve } from "node:path";
import { homedir } from "node:os";
import { ref } from "vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faSave, faTrash } from "@fortawesome/free-solid-svg-icons";
import { faFile } from "@fortawesome/free-regular-svg-icons";
defineProps({
  disabled: {
    type: Boolean,
    default: false,
  },
});
const emit = defineEmits<{
  save: [path: string, img_format: string];
  exit: [];
}>();
function getDefaultPath() {
  const timestamp =
    new Date().toISOString().replace(/[:.]/g, "-").split("T")[0] +
    "_" +
    new Date().toTimeString().split(" ")[0].replace(/:/g, "-");
  return resolve(homedir(), "Downloads", timestamp);
}
const img_format = ref("png");
const save_path = ref(getDefaultPath());
function selectPath() {}
</script>

<template>
  <div class="save-controls">
    Directory:
    <div class="path-select">
      <input
        type="text"
        v-model="save_path"
        placeholder="Select save directory..."
        readonly
        class="path-input"
        :disabled="disabled"
      />
      <button @click="selectPath" class="browse-btn" :disabled="disabled">
        <Icon :icon="faFile" />
      </button>
    </div>
    <div class="divider"></div>
    <div class="format-select">
      <label>
        Image Format:
        <select v-model="img_format" :disabled="disabled">
          <option value="png">PNG</option>
          <option value="jpg">JPG</option>
          <option value="bmp">BMP</option>
          <option value="tiff">TIFF</option>
        </select>
      </label>
    </div>
    <div class="divider"></div>
    <button
      @click="emit('save', save_path, img_format)"
      class="action green"
      :disabled="disabled"
    >
      <Icon :icon="faSave" /> <span>Save</span>
    </button>
    <button @click="emit('exit')" class="action red" :disabled="disabled">
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
  &:focus-within {
    outline: 1px solid #0af;
  }
}

.path-input {
  border: none;
  background: none;
  color: inherit;
  padding: 0.5em;
  font-family: monospace;
  flex-grow: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  outline: none;
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
