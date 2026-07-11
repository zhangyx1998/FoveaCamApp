<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Dismissible error tray (value-sweep-2026-07-11
  `error-broadcast-dead-ends-in-console`). Everything the orchestrator's
  process-wide `report()` carried — camera-registry sink throws, recorder
  finalize truncations, capture-worker death, unhandled command rejections —
  used to terminate at renderer `console.error`, invisible in a packaged app.
  This title-bar chrome renders the bounded, coalesced ring `client.ts` keeps
  (`errorTray`): a badge with the live count, a dropdown of recent reports
  (scope · message · ×count · age), per-row copy + dismiss, and clear-all. An
  empty ring flips the panel to the `--ok` green identity (all-clear at a
  glance); any report restores the danger identity.

  Dark-lab operator language (docs/design/design-language.md): monospace, the
  one `--danger` error identity, tokens over raw hex, icon-only title-bar button
  with an explicit `title=` (§ ruled principle 4), snap (no transitions) on this
  glanceable failure surface.
-->
<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faTriangleExclamation,
  faTrashCan,
  faXmark,
  faCopy,
  faCheck,
} from "../windows/icons";
import {
  errorTray,
  dismissError,
  clearErrors,
  type ErrorReport,
} from "@lib/orchestrator/client";

const open = ref(false);
const count = computed(() => errorTray.length);

// Live "age" clock — a 1 Hz tick so the relative timestamps stay current while
// the panel is open, without a per-row timer.
const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => clearInterval(clock));

function ago(ts: number): string {
  const s = Math.max(0, Math.round((now.value - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function toggle(): void {
  open.value = !open.value;
}

function dismiss(report: ErrorReport): void {
  dismissError(report);
  if (errorTray.length === 0) open.value = false;
}

// Per-row copy: the full report details as one plain-text line — ISO time of
// the most recent occurrence, scope, message, and the coalesce count.
function reportText(report: ErrorReport): string {
  const times = report.count > 1 ? ` (×${report.count})` : "";
  return `${new Date(report.lastAt).toISOString()} [${report.scope}] ${report.message}${times}`;
}

const copiedKey = ref<string | null>(null);
// Row identity: coalescing guarantees firstAt+scope+message uniqueness (a count
// bump keeps the object; scope alone can collide within one millisecond).
const rowKey = (report: ErrorReport) =>
  `${report.firstAt}|${report.scope}|${report.message}`;
async function copy(report: ErrorReport): Promise<void> {
  try {
    await navigator.clipboard.writeText(reportText(report));
    const key = rowKey(report);
    copiedKey.value = key;
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null;
    }, 1200);
  } catch {
    /* clipboard unavailable */
  }
}

function clearAll(): void {
  clearErrors();
  open.value = false;
}
</script>

<template>
  <div class="error-tray">
    <button
      class="icon-button"
      :class="{ active: count > 0, open }"
      :title="count > 0 ? `${count} error report(s)` : 'No recent errors'"
      @click="toggle"
    >
      <Icon :icon="faTriangleExclamation" />
      <span v-if="count > 0" class="badge">{{ count > 99 ? "99+" : count }}</span>
    </button>

    <div v-if="open" class="panel" :class="{ ok: count === 0 }">
      <div class="panel-head">
        <span class="panel-title">{{ count === 0 ? "All clear" : "Errors" }}</span>
        <button
          class="clear"
          :disabled="count === 0"
          title="Clear all errors"
          @click="clearAll"
        >
          <Icon :icon="faTrashCan" />
        </button>
      </div>
      <div v-if="count === 0" class="empty">No recent errors.</div>
      <ul v-else class="list">
        <li v-for="report in errorTray" :key="rowKey(report)" class="row">
          <div class="row-main">
            <span class="scope">{{ report.scope }}</span>
            <span v-if="report.count > 1" class="times">×{{ report.count }}</span>
            <span class="age">{{ ago(report.lastAt) }}</span>
            <button
              class="row-action"
              :title="copiedKey === rowKey(report) ? 'Copied' : 'Copy error details'"
              @click="copy(report)"
            >
              <Icon :icon="copiedKey === rowKey(report) ? faCheck : faCopy" />
            </button>
            <button
              class="row-action"
              title="Dismiss"
              @click="dismiss(report)"
            >
              <Icon :icon="faXmark" />
            </button>
          </div>
          <div class="message">{{ report.message }}</div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped lang="scss">
.error-tray {
  position: relative;
  display: inline-flex;
}

// Mirrors AppWindow's `.icon-button` idiom (§ ruled principle 4 — icon-only
// title bar), plus a danger tint when reports are present.
.icon-button {
  position: relative;
  background: none;
  border: none;
  padding: 0.4em;
  margin: 0;
  cursor: pointer;
  color: var(--text-faint);
  border-radius: 4px;
  outline: 1px solid transparent;

  &.active {
    color: var(--danger-text);
  }

  &:hover,
  &.open {
    background: var(--tint-1);
    outline: 1px solid var(--border-muted);
  }
}

.badge {
  position: absolute;
  top: -0.15em;
  right: -0.15em;
  min-width: 1.4ch;
  padding: 0 0.3ch;
  font-size: 0.6em;
  line-height: 1.5;
  text-align: center;
  color: var(--text);
  background: var(--danger);
  border-radius: 0.8em;
}

.panel {
  position: absolute;
  top: calc(100% + 0.3em);
  right: 0;
  z-index: 100;
  width: min(48ch, 80vw);
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-chrome);
  border: 1px solid var(--danger-strong);
  border-radius: 0.4em;
  box-shadow: 0 0.4em 1.2em rgba(0, 0, 0, 0.6);
  overflow: hidden;
  font-size: 0.8em;

  // Empty ring = all-clear: the one `--ok` green identity replaces the danger
  // frame (snap, no transition — glanceable state, ruled principle).
  &.ok {
    border-color: var(--ok);

    .panel-title {
      color: var(--ok);
    }
  }
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4em 1ch;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel-alt);
}

.panel-title {
  color: var(--danger-text);
  font-weight: 600;
}

.clear {
  background: none;
  border: none;
  padding: 0.2em 0.4em;
  cursor: pointer;
  color: var(--text-muted);
  border-radius: 3px;

  &:not(:disabled):hover {
    color: var(--danger-text);
    background: var(--tint-1);
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

.empty {
  padding: 1em 1ch;
  text-align: center;
  color: var(--text-faint);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
}

.row {
  padding: 0.4em 1ch;
  border-bottom: 1px solid var(--border);

  &:last-child {
    border-bottom: none;
  }
}

.row-main {
  display: flex;
  align-items: center;
  gap: 0.8ch;
}

.scope {
  color: var(--warn);
  white-space: nowrap;
}

.times {
  color: var(--danger-text);
  white-space: nowrap;
}

.age {
  margin-left: auto;
  color: var(--text-faint);
  white-space: nowrap;
}

.row-action {
  background: none;
  border: none;
  // Matches `.clear` — two adjacent targets (one destructive) need real
  // hit area, not the old single-dismiss sliver.
  padding: 0.2em 0.4em;
  cursor: pointer;
  color: var(--text-faint);
  border-radius: 3px;

  &:hover {
    color: var(--text);
    background: var(--tint-1);
  }
}

.message {
  margin-top: 0.2em;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
