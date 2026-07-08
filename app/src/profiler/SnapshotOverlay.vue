<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->

<!-- Snapshot-export result popup, raised through the shared title-bar
     overlay mechanism (Overlay.vue / TitleBar's overlay pane — the same
     surface the recorder's RecordControls uses). TitleBar mounts overlay
     components without props, so the result rides in a module-scope ref
     set by ProfilerWindow right before it raises the overlay (the exact
     pattern RecordControls uses with `current_recording`). -->

<script lang="ts">
import { ref } from "vue";
export type SnapshotResult = { path: string } | { error: string };
export const snapshotResult = ref<SnapshotResult | null>(null);
</script>

<script setup lang="ts">
import { computed } from "vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faFileExport,
  faFolderOpen,
  faTriangleExclamation,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";

const emit = defineEmits(["exit"]);

const path = computed(() => {
  const r = snapshotResult.value;
  return r && "path" in r ? r.path : null;
});
const error = computed(() => {
  const r = snapshotResult.value;
  return r && "error" in r ? r.error : null;
});

function reveal(): void {
  if (path.value) void window.foveaBridge.revealPerfSnapshot(path.value);
  emit("exit");
}
</script>

<template>
  <div class="snapshot-popup">
    <template v-if="path">
      <div class="title"><Icon :icon="faFileExport" /> Snapshot exported</div>
      <div class="path-row">{{ path }}</div>
      <div class="buttons">
        <button class="action green" @click="reveal">
          <Icon :icon="faFolderOpen" /> <span>Reveal in Finder</span>
        </button>
        <button class="action" @click="emit('exit')">
          <Icon :icon="faXmark" /> <span>Close</span>
        </button>
      </div>
    </template>
    <template v-else>
      <div class="title error">
        <Icon :icon="faTriangleExclamation" /> Snapshot export failed
      </div>
      <div class="path-row error">{{ error ?? "unknown error" }}</div>
      <div class="buttons">
        <button class="action red" @click="emit('exit')">
          <Icon :icon="faXmark" /> <span>Close</span>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.snapshot-popup {
  position: absolute;
  top: 10px;
  right: 10px;
  min-width: 50ch;
  max-width: 100ch;
  background: #222e;
  backdrop-filter: blur(12px);
  border: 1px solid #fff3;
  border-radius: 6px;
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
  display: flex;
  align-items: center;
  gap: 0.6ch;
  &.error {
    color: #f88;
  }
}

.path-row {
  border: 1px solid #fff3;
  border-radius: 4px;
  background-color: #fff1;
  padding: 0.3em 0.5em;
  font-family: monospace;
  color: white;
  word-break: break-all;
  user-select: text; // copyable
  &.error {
    color: #ff0;
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
  background: #fff2;
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
  &:hover {
    filter: brightness(1.2);
  }
}
</style>
