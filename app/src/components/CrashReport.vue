<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Orchestrator crash banner. Mounted in the windows associated with the
  orchestrated task (app window + its owned
  debug sub-window). Renders off the reactive `orchestratorDown` report exposed
  by the orchestrator client, which is set ONLY in windows that actually held a
  channel — so owner-scoping falls out for free. A `clean` report is recorded
  but hidden (a graceful shutdown is not a user-facing failure).

  DELIBERATELY MINIMAL + neutral-styled; all styles live here (no scattered hex
  elsewhere). "Reopen app" reloads the window, which re-runs the orchestrator
  connect handshake (main lazily respawns the orchestrator) — transparent
  reconnect is out of scope.
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

// Crash diagnostics: present only on a non-clean exit that captured output / a
// minidump.
const lastLines = computed(() => report.value?.lastLines ?? []);
const logText = computed(() => lastLines.value.join("\n"));
const logPath = computed(() => report.value?.logPath ?? "");
const dumpPath = computed(() => report.value?.dumpPath ?? "");
const hasDiagnostics = computed(
  () => lastLines.value.length > 0 || !!logPath.value || !!dumpPath.value,
);

/** Basename for a compact, path-safe label (full path is the button title). */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function reveal(p: string): void {
  if (p) window.foveaBridge.revealCrashFile(p);
}

function reopen(): void {
  // Fresh window → fresh orchestrator connect (main respawns it on demand).
  window.location.reload();
}
</script>

<template>
  <div v-if="show" class="crash-report" role="alert">
    <div class="crash-head">
      <div class="crash-body">
        <span class="crash-dot" aria-hidden="true"></span>
        <span class="crash-text">{{ headline }}</span>
      </div>
      <button class="crash-reopen" type="button" @click="reopen">Reopen app</button>
    </div>

    <!-- Diagnostics: collapsed by default; the log tail scrolls WITHIN its own
         fixed-height box so expanding never grows the banner unbounded. -->
    <details v-if="hasDiagnostics" class="crash-diag">
      <summary class="crash-diag-summary">Diagnostics</summary>
      <div class="crash-diag-body">
        <pre v-if="lastLines.length" class="crash-log"><code>{{ logText }}</code></pre>
        <div v-if="logPath || dumpPath" class="crash-paths">
          <div v-if="logPath" class="crash-path-row">
            <span class="crash-path-label">Log</span>
            <button
              class="crash-reveal"
              type="button"
              :title="logPath"
              @click="reveal(logPath)"
            >
              {{ baseName(logPath) }} · Reveal in Finder
            </button>
          </div>
          <div v-if="dumpPath" class="crash-path-row">
            <span class="crash-path-label">Dump</span>
            <button
              class="crash-reveal"
              type="button"
              :title="dumpPath"
              @click="reveal(dumpPath)"
            >
              {{ baseName(dumpPath) }} · Reveal in Finder
            </button>
          </div>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped lang="scss">
/* One app error identity: --danger family, --font-mono. A fixed overlay
   banner (does not reflow page content) that is instantly visible — no fade-in.
   Bottom-anchored, so the diagnostics block grows UPWARD on expand and its log
   tail scrolls internally — the page never shifts. */
.crash-report {
  position: fixed;
  z-index: 9999;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  max-width: min(560px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--danger-bg);
  border: 1px solid var(--danger-strong);
  color: var(--danger-text);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 6px 24px var(--shadow);
}

.crash-head {
  display: flex;
  align-items: center;
  gap: 16px;
}

.crash-body {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1 1 auto;
}

.crash-dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--danger-strong);
}

.crash-text {
  min-width: 0;
}

.crash-reopen {
  flex: none;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--danger-strong);
  background: transparent;
  color: var(--danger-text);
  font: inherit;

  &:hover {
    background: var(--tint-1);
  }
}

/* Collapsed by default. Expanding reveals a fixed-height, internally-scrolling
   log tail + reveal affordances — the banner never grows unbounded. */
.crash-diag {
  border-top: 1px solid var(--danger-strong);
  padding-top: 8px;
}

.crash-diag-summary {
  cursor: pointer;
  list-style: none;
  user-select: none;
  font-size: 12px;
  opacity: 0.85;

  &::-webkit-details-marker {
    display: none;
  }

  &::before {
    content: "▸";
    display: inline-block;
    width: 1em;
  }

  .crash-diag[open] &::before {
    content: "▾";
  }
}

.crash-diag-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.crash-log {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  /* Keep wheel/trackpad momentum inside the log tail — never chain-scroll the
     app behind this fixed banner (layout stability; no prior idiom exists). */
  overscroll-behavior: contain;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--tint-1);
  border: 1px solid var(--danger-strong);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  tab-size: 2;

  code {
    font: inherit;
    color: inherit;
  }
}

.crash-paths {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.crash-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.crash-path-label {
  flex: none;
  width: 3em;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
}

.crash-reveal {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
  text-align: left;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--danger-strong);
  background: transparent;
  color: var(--danger-text);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  &:hover {
    background: var(--tint-1);
  }
}
</style>
