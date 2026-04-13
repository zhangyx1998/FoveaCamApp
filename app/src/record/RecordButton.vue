<script setup lang="ts">
import { computed, ref } from "vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faCircle } from "@fortawesome/free-solid-svg-icons";
import { overlay } from "@src/components/Overlay.vue";
import { current_recording } from ".";
import RecordControls from "./RecordControls.vue";

const isAvailable = computed(() => current_recording.value !== null);
const isRecording = computed(
  () => current_recording.value?.active.value ?? false,
);
const streams = computed(() => current_recording.value?.streams);
const hover = ref(false);

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function handleClick() {
  if (isRecording.value) {
    current_recording.value?.stop();
  } else if (isAvailable.value) {
    overlay.value = { overlay: RecordControls };
  }
}
</script>

<template>
  <div class="record-btn-wrap">
    <button
      class="record-toggle"
      :class="{ active: isRecording }"
      :disabled="!isAvailable"
      @click="handleClick"
      @mouseenter="hover = true"
      @mouseleave="hover = false"
    >
      <div class="circle-outline">
        <Icon :icon="faCircle" />
      </div>
    </button>
    <table v-if="isRecording && hover && streams" class="record-tooltip">
      <tr v-for="[name, info] of streams" :key="name">
        <td class="stream-name">{{ name }}</td>
        <td class="stream-frames">{{ info.frames }}</td>
        <td class="stream-fps">{{ info.fps.toFixed(1) }} fps</td>
        <td class="stream-bytes">{{ formatSize(info.bytes) }}</td>
        <td v-if="info.dropped" class="stream-dropped">-{{ info.dropped }}</td>
      </tr>
    </table>
  </div>
</template>

<style scoped lang="scss">
.record-btn-wrap {
  position: relative;
}

.record-toggle {
  background: none;
  border: none;
  padding: 0.4em;
  margin: 0;
  cursor: pointer;
  color: inherit;
  border-radius: 4px;
  transition: all 0.1s;
  outline: 1px solid transparent;

  &:hover {
    background: #fff1;
  }

  &:not(.active):not(:disabled):hover {
    outline: 1px solid #666;
  }
  .circle-outline {
    border-radius: 50%;
    outline: 1.5px solid currentColor;
    width: 1.6em;
    height: 1.6em;
    font-size: 0.6em;
    display: flex;
    align-items: center;
    justify-content: center;
    --opacity: 0.5;
    & > * {
      opacity: var(--opacity);
    }
  }

  &.active .circle-outline {
    color: #f33;
    animation: record-blink 1s steps(1, end) infinite;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}

@keyframes record-blink {
  0%,
  50% {
    --opacity: 1;
  }
  51%,
  100% {
    --opacity: 0.5;
  }
}

.record-tooltip {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  padding: 0.5em 0.8em;
  background: #222e;
  backdrop-filter: blur(8px);
  border: 1px solid #fff3;
  border-radius: 4px;
  white-space: nowrap;
  font-size: 0.75em;
  z-index: 100;
  pointer-events: none;

  td {
    font-family: monospace;
    padding: 0 0.5ch;
    &.stream-name {
      color: #aaa;
    }
    &.stream-frames {
      color: #fff;
      text-align: right;
    }
    &.stream-fps {
      color: #8f8;
      text-align: right;
    }
    &.stream-bytes {
      color: #8cf;
      text-align: right;
    }
    &.stream-dropped {
      color: #f66;
      text-align: right;
    }
  }
}
</style>
