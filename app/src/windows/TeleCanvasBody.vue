<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  TeleCanvas window body (async; mounted under TeleCanvasWindow's <Suspense>).
  Live projection preview + mode switch + per-mode controls:
    • client — the remote TeleCanvas server URL + a note that the running app's
      windows push the content there. Preview mirrors THIS window's local
      providers (none here → the splash).
    • host — this app's own server: listening state, reachable viewer URLs (each
      with a copy button), and a live preview taken from the server's OWN SSE
      stream (truthful — it renders exactly what an external display renders).

  mode/url/port bind to the shared `["config"]` document via `useConfigRef`, so
  edits apply live across windows (the push watchers pick up the new target). On
  a mode/port change this window also nudges main (`applyTeleCanvas`) so the
  main-owned host process reconciles.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useConfigRef } from "@lib/config";
import { content, hasProviders } from "../components/telecanvas/registry";
import {
  DEFAULT_TELECANVAS_PORT,
  IDLE_TELECANVAS_STATUS,
  type TeleCanvasStatus,
} from "@lib/telecanvas";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faCopy, faCheck, faTelevision } from "@fortawesome/free-solid-svg-icons";

// ---- Config (live, writable refs over the shared document) -----------------
const mode = await useConfigRef("tele_canvas_mode");
const url = await useConfigRef("tele_canvas_url");
const port = await useConfigRef("tele_canvas_port");

const isHost = computed(() => (mode.value ?? "client") === "host");

// Presentation-only URL validity (client mode): empty = disabled (not invalid);
// a non-empty string that isn't a parseable URL gets the settings `.invalid`
// underline. No effect on the push path — the pusher already guards bad URLs.
const urlInvalid = computed(() => {
  const u = (url.value ?? "").trim();
  if (!u) return false;
  try {
    new URL(u);
    return false;
  } catch {
    return true;
  }
});

function setMode(next: "client" | "host") {
  mode.value = next;
}

// Nudge main with the full push target on any mode/port/url change (+ once on
// open). Main reconciles the host process AND re-broadcasts {mode, url, port} to
// every window so app-window pushers in OTHER orchestrator instances follow.
watch(
  () =>
    [
      mode.value ?? "client",
      port.value ?? DEFAULT_TELECANVAS_PORT,
      url.value ?? "",
    ] as const,
  ([m, p, u]) => window.foveaBridge.applyTeleCanvas(m, p, u),
  { immediate: true },
);

// ---- Host status from main -------------------------------------------------
const status = ref<TeleCanvasStatus>(IDLE_TELECANVAS_STATUS);
let disposeStatus: (() => void) | null = null;
onMounted(async () => {
  try {
    status.value = await window.foveaBridge.getTeleCanvasStatus();
  } catch {
    /* keep idle default */
  }
  disposeStatus = window.foveaBridge.onTeleCanvasStatus((s) => (status.value = s));
});

// ---- Preview ---------------------------------------------------------------
// host: subscribe to the server's own SSE stream (truthful preview). client:
// mirror this window's local providers (splash when none).
const preview = ref<string>(content.value);
let es: EventSource | null = null;
function closeStream() {
  es?.close();
  es = null;
}
function openStream(p: number) {
  closeStream();
  es = new EventSource(`http://127.0.0.1:${p}/events`);
  es.onmessage = (e) => {
    try {
      preview.value = JSON.parse(e.data);
    } catch {
      /* ignore malformed frame */
    }
  };
  // EventSource auto-reconnects on error; nothing more to do.
}

// (Re)connect the preview stream whenever host mode / port / listening changes.
watch(
  () => [isHost.value, status.value.listening, port.value ?? DEFAULT_TELECANVAS_PORT] as const,
  ([host, , p]) => {
    if (host) openStream(p);
    else {
      closeStream();
      preview.value = content.value; // back to local providers / splash
    }
  },
  { immediate: true },
);
// In client mode the preview tracks local providers live.
watch(content, (c) => {
  if (!isHost.value) preview.value = c;
});
onUnmounted(() => {
  closeStream();
  disposeStatus?.();
});

// ---- Copy-to-clipboard -----------------------------------------------------
const copied = ref<string | null>(null);
async function copy(u: string) {
  try {
    await navigator.clipboard.writeText(u);
    copied.value = u;
    setTimeout(() => {
      if (copied.value === u) copied.value = null;
    }, 1200);
  } catch {
    /* clipboard unavailable */
  }
}
</script>

<template>
  <div class="scroll">
    <!-- Live preview -->
    <svg class="preview" viewBox="-240 -135 480 270" v-html="preview"></svg>

    <!-- Mode switch -->
    <div class="mode">
      <button :class="{ active: !isHost }" @click="setMode('client')">Client</button>
      <button :class="{ active: isHost }" @click="setMode('host')">Host</button>
    </div>

    <!-- Client mode -->
    <section v-if="!isHost">
      <label class="row">
        <span class="label">Server URL</span>
        <input type="text" v-model="url" :class="{ invalid: urlInvalid }" placeholder="empty = disabled" />
      </label>
      <p class="hint">
        This app's windows PUT their projection to this remote TeleCanvas server.
        Leave empty to disable. Preview above shows this window's own content
        <span v-if="!hasProviders">(the splash — live markers are pushed by the app windows)</span>.
      </p>
    </section>

    <!-- Host mode -->
    <section v-else>
      <label class="row">
        <span class="label">Server port</span>
        <span class="field">
          <input type="number" step="1" min="1" max="65535" v-model.number="port" />
        </span>
      </label>
      <div class="status-row">
        <span class="dot" :class="{ ok: status.listening, err: !!status.error }"></span>
        <span v-if="status.listening">Serving on port {{ status.port }}</span>
        <span v-else-if="status.error" class="err">{{ status.error }}</span>
        <span v-else>Starting…</span>
      </div>
      <p class="hint">
        Open one of these URLs in a browser on a TV or tablet on the same network.
        The preview above is taken from the server's own live stream.
      </p>
      <ul class="urls" v-if="status.urls.length">
        <li v-for="u in status.urls" :key="u">
          <Icon :icon="faTelevision" class="u-icon" />
          <span class="u-text" :title="u">{{ u }}</span>
          <button class="icon-button" :title="copied === u ? 'Copied' : 'Copy'" @click="copy(u)">
            <Icon :icon="copied === u ? faCheck : faCopy" />
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped lang="scss">
.scroll {
  height: 100%;
  overflow-y: auto;
  padding: 1rem 1.5rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.preview {
  width: 100%;
  aspect-ratio: 16 / 9;
  background-color: var(--bg-canvas);
  border: 2px solid var(--border-muted);
  border-radius: 4px;
  :deep(text) {
    fill: white;
    dominant-baseline: middle;
    text-anchor: middle;
  }
}

.mode {
  display: flex;
  gap: 0;
  align-self: center;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;

  button {
    font-family: inherit;
    font-size: 1em;
    padding: 0.4em 1.4em;
    background: var(--bg-chrome);
    color: var(--text-muted);
    border: none;
    cursor: pointer;
    &:not(:last-child) {
      border-right: 1px solid var(--border-muted);
    }
    &.active {
      background: var(--accent-bright);
      color: var(--bg-app);
    }
    &:not(.active):hover {
      background: var(--tint-1);
      color: var(--text);
    }
  }
}

section {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  min-height: 2.2em;

  .label {
    color: var(--text-muted);
  }
  input[type="text"] {
    flex: 1;
    min-width: 20ch;
    max-width: 42ch;
  }
  input[type="number"] {
    width: 10ch;
    text-align: right;
  }
}

input {
  font-family: inherit;
  font-size: 1em;
  color: var(--text);
  background-color: var(--bg-chrome);
  border: none;
  border-bottom: 2px solid var(--border-muted);
  outline: none;
  padding: 0.3em 0.5em;
  &:hover {
    border-bottom-color: var(--text-muted);
  }
  &:focus {
    border-bottom-color: var(--accent-bright);
  }
  &.invalid {
    border-bottom-color: var(--danger);
  }
}

.status-row {
  display: flex;
  align-items: center;
  gap: 1ch;
  color: var(--text-dim);
  font-size: 0.95em;

  .dot {
    width: 0.7em;
    height: 0.7em;
    border-radius: 50%;
    background: var(--warn); /* starting / transient — not yet an error */
    flex-shrink: 0;
    &.ok {
      background: var(--ok);
    }
    &.err {
      background: var(--danger);
    }
  }
  .err {
    color: var(--danger-text);
  }
}

.hint {
  color: var(--text-faint);
  font-size: var(--fs-sm);
  margin: 0;
}

.urls {
  list-style: none;
  margin: 0.2rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;

  li {
    display: flex;
    align-items: center;
    gap: 1ch;
    padding: 0.4em 0.6em;
    border: 1px solid var(--border);
    border-radius: 4px;
    background-color: var(--bg-panel-alt);

    .u-icon {
      color: var(--text-muted);
    }
    .u-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      user-select: text;
    }
  }
}

.icon-button {
  background: none;
  border: none;
  padding: 0.4em;
  margin: 0;
  cursor: pointer;
  color: inherit;
  border-radius: 4px;
  outline: 1px solid transparent;
  &:not(:disabled):hover {
    background: var(--tint-1);
    outline: 1px solid var(--border-muted);
  }
}
</style>
