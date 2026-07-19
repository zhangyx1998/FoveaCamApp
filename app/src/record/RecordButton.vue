<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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

// Cmd/Ctrl-R consumer. Main rebinds plain
// Cmd/Ctrl-R off reload and pushes `recorder:trigger` to the focused window;
// here it toggles recording where a context exists — start (resolving the save
// path exactly like RecordControls' Start button) / stop — else a no-op.
let triggerBusy = false;
async function handleRecorderTrigger(): Promise<void> {
  if (triggerBusy) return;
  const rec = current_recording.value;
  if (!rec) return; // no recording context here → no-op
  triggerBusy = true;
  try {
    if (rec.active.value) {
      await rec.stop();
    } else {
      // Same resolution RecordControls.start() does, but against the current
      // save-path defaults (no dialog): resolve <dir>/<sequence>, start, bump.
      const path = rec.current_path;
      const full = await window.foveaBridge.resolvePath(path, rec.sequence);
      await rec.start(full);
      rec.updateSequence(rec.sequence);
      rec.current_path = path;
    }
  } finally {
    triggerBusy = false;
  }
}

let disposeTrigger: (() => void) | null = null;
onMounted(() => {
  disposeTrigger =
    window.foveaBridge?.onRecorderTrigger?.(() => void handleRecorderTrigger()) ??
    null;
});
onBeforeUnmount(() => {
  disposeTrigger?.();
  disposeTrigger = null;
});

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
      <thead>
        <tr>
          <th></th>
          <th>pub</th>
          <th>wrote</th>
          <th>fps</th>
          <th>size</th>
          <th>drops</th>
        </tr>
      </thead>
      <tbody>
        <!-- published = written + drops (pinned invariant); the drops cell
             splits queue-overflow (q) vs ring-lapped (r) so a recording run
             reads the cause without devtools. -->
        <tr v-for="[name, info] of streams" :key="name">
          <td class="stream-name">{{ name }}</td>
          <td class="stream-pub">{{ info.frames + info.dropped }}</td>
          <td class="stream-frames">{{ info.frames }}</td>
          <td class="stream-fps">{{ info.fps.toFixed(1) }}</td>
          <td class="stream-bytes">{{ formatSize(info.bytes) }}</td>
          <td v-if="info.dropped" class="stream-dropped">
            -{{ info.dropped }}
            <span class="drop-cause">(q{{ info.droppedQueue ?? 0 }}/r{{ info.droppedRing ?? 0 }})</span>
          </td>
          <td v-else class="stream-dropped ok">0</td>
        </tr>
      </tbody>
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
  // Critical control (record toggle): instant hover feedback, no transition
  // (realtime feedback / snap over smooth).
  outline: 1px solid transparent;

  &:hover {
    background: var(--tint-1);
  }

  &:not(.active):not(:disabled):hover {
    outline: 1px solid var(--border-muted);
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
    color: var(--danger-strong);
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
  /* translucent panel wash (kept literal — no semantic token for the alpha) */
  background: #222e;
  backdrop-filter: blur(8px);
  border: 1px solid var(--tint-3);
  border-radius: 4px;
  white-space: nowrap;
  font-size: 0.75em;
  z-index: 100;
  pointer-events: none;

  th {
    font-family: var(--font-mono);
    padding: 0 0.5ch 0.2em;
    color: var(--text-faint);
    font-weight: 600;
    text-align: right;
    &:first-child {
      text-align: left;
    }
  }

  td {
    font-family: var(--font-mono);
    padding: 0 0.5ch;
    &.stream-name {
      color: var(--text-muted);
    }
    &.stream-pub {
      color: var(--text-dim);
      text-align: right;
    }
    &.stream-frames {
      color: var(--text);
      text-align: right;
    }
    &.stream-fps {
      color: var(--ok);
      text-align: right;
    }
    // Telemetry categorical accents (bytes blue / drop-cause dim red / drops-ok
    // dim green) kept literal — a per-column palette, not a semantic role.
    &.stream-bytes {
      color: #8cf;
      text-align: right;
    }
    &.stream-dropped {
      color: var(--danger-text);
      text-align: right;
      &.ok {
        color: #575;
      }
      .drop-cause {
        color: #b77;
        font-size: 0.85em;
      }
    }
  }
}
</style>
