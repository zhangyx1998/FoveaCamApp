<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Orchestrator crash banner (orchestrator-lifecycle-and-exit ruling 4). Mounted
  in the windows associated with the orchestrated task (app window + its owned
  debug sub-window). Renders off the reactive `orchestratorDown` report exposed
  by the orchestrator client, which is set ONLY in windows that actually held a
  channel — so owner-scoping falls out for free. A `clean` report is recorded
  but hidden (a graceful shutdown is not a user-facing failure).

  DELIBERATELY MINIMAL + neutral-styled — a design-tokens wave restyles this;
  all styles live here (no scattered hex elsewhere). "Reopen app" reloads the
  window, which re-runs the orchestrator connect handshake (main lazily respawns
  the orchestrator) — transparent reconnect is out of scope (client.ts §12.1 C5).
-->
<script setup lang="ts">
import { computed } from "vue";
import { orchestratorDown } from "@lib/orchestrator/client";

const report = computed(() => orchestratorDown.value);
const show = computed(() => !!report.value && report.value.reason !== "clean");

const headline = computed(() => {
  const r = report.value;
  if (!r) return "";
  const code = r.code ?? "unknown";
  const verb = r.reason === "killed" ? "stopped" : "crashed";
  return `Orchestrator ${verb} (code ${code}) — hardware parked by cleanup worker.`;
});

function reopen(): void {
  // Fresh window → fresh orchestrator connect (main respawns it on demand).
  window.location.reload();
}
</script>

<template>
  <div v-if="show" class="crash-report" role="alert">
    <div class="crash-body">
      <span class="crash-dot" aria-hidden="true"></span>
      <span class="crash-text">{{ headline }}</span>
    </div>
    <button class="crash-reopen" type="button" @click="reopen">Reopen app</button>
  </div>
</template>

<style scoped lang="scss">
.crash-report {
  position: fixed;
  z-index: 9999;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  max-width: min(560px, calc(100vw - 32px));
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  border-radius: 8px;
  background: #2a1416;
  border: 1px solid #7a2a2f;
  color: #f2d7d9;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 6px 24px #0008;
}

.crash-body {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.crash-dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #e5484d;
}

.crash-text {
  min-width: 0;
}

.crash-reopen {
  flex: none;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #7a2a2f;
  background: #3a1a1d;
  color: #f2d7d9;
  font: inherit;
  transition: background 0.1s;

  &:hover {
    background: #4a2226;
  }
}
</style>
