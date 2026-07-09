<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Orchestrator spin-up progress overlay (user ruling 2026-07-09): app windows
  blank out during session activation / graph building with no indicator. This
  is the reusable, app-agnostic overlay — `AppWindow` hosts one for whatever
  session it hosts, driven by that session's `status.progress` (see
  `@lib/orchestrator/progress`). Presentation only: the host decides when it is
  visible and owns the dismiss state; this emits `close` (the top-right × that
  reveals the partially-loaded app underneath) and renders the step list.
-->
<script setup lang="ts">
import type { ProgressItem } from "@lib/orchestrator/progress";

defineProps<{ items: ProgressItem[] }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="progress-monitor" role="status" aria-live="polite">
    <!-- Top-right override: hidden until the monitor is hovered, revealing the
         partially-loaded app behind (CSS-only reveal). -->
    <button class="dismiss" title="Dismiss (show the app)" @click="emit('close')">
      &times;
    </button>
    <ul class="steps">
      <li v-for="item in items" :key="item.id" :class="['step', item.state]">
        <span class="bullet" aria-hidden="true">
          <span v-if="item.state === 'active'" class="spinner" />
          <template v-else-if="item.state === 'done'">&#10003;</template>
          <template v-else>&#9203;</template>
        </span>
        <span class="label">{{ item.label }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
.progress-monitor {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  // Dark backdrop consistent with the app's #111/#222 palette.
  background: #111c;
  backdrop-filter: blur(2px);
}

.dismiss {
  position: absolute;
  top: 0.75em;
  right: 0.75em;
  width: 2em;
  height: 2em;
  padding: 0;
  border: 1px solid #666;
  border-radius: 4px;
  background: #222;
  color: #ccc;
  font-size: 1.1em;
  line-height: 1;
  cursor: pointer;
  // The override is invisible until the user hovers the overlay — then it
  // reveals, offering the escape hatch to the partially-loaded app.
  opacity: 0;
  transition: opacity 0.15s;

  &:hover {
    background: #333;
    color: #fff;
  }
}

.progress-monitor:hover .dismiss {
  opacity: 1;
}

.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75em;
}

.step {
  display: flex;
  align-items: center;
  gap: 0.75ch;
  font-size: 1.05em;
  // pending: dimmed foreground.
  color: #777;
  transition: color 0.15s;

  &.active {
    color: #eee; // bright foreground
  }

  &.done {
    color: #4caf50; // green
  }
}

.bullet {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.4em;
  height: 1.4em;
  flex: none;
  font-size: 1em;
}

.spinner {
  width: 1em;
  height: 1em;
  border: 2px solid #eee5;
  border-top-color: #eee;
  border-radius: 50%;
  animation: progress-spin 0.8s linear infinite;
}

@keyframes progress-spin {
  to {
    transform: rotate(360deg);
  }
}

.label {
  user-select: none;
}
</style>
