<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  TeleCanvas PUSH (per app window). Renders nothing — it watches the merged
  provider `content` and PUTs it to the active TeleCanvas target on every change,
  always-on (not only while an overlay is open) and in BOTH modes:
    • client → the configured remote `tele_canvas_url` (empty = disabled).
    • host   → this app's own server at http://127.0.0.1:<tele_canvas_port>/.
  Only the target URL differs between modes; the render/push path is identical.

  The push TARGET comes from MAIN (`getTeleCanvasTarget` + `onTeleCanvasTarget`),
  NOT from this window's config store. Under the disposable-orchestrator refactor
  every app and the settings window run their OWN orchestrator instance, and the
  `["config"]` store-hub broadcast does NOT cross instances — so a settings edit
  made in a different instance would never reach this app window's store. Main is
  the single always-alive process and the cross-instance authority (it already
  owns the host process + status), so it is the truthful source of WHERE to push.
  A target broadcast ALSO re-fires on a host (re)listen so a freshly respawned
  host gets its buffer refilled by the next PUT (content preservation).

  Pushes go through the package's `TeleCanvasClient` (telecanvas/view): at most
  one PUT in flight, newer frames overwrite queued ones — a burst of DOM
  mutations coalesces to the newest frame. AppWindow mounts this under
  <Suspense> (harmless — the async work is in onMounted, not a top-level
  await).
-->
<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { TeleCanvasClient } from "telecanvas/view";
import { content } from "./registry";
import {
  IDLE_TELECANVAS_TARGET,
  teleCanvasTarget,
  type TeleCanvasTarget,
} from "@lib/telecanvas";

/** Coalescing PUT client for the active target, or null when disabled (client
 *  mode with an empty URL). Seeded from main at mount, swapped on every target
 *  broadcast. */
let client: TeleCanvasClient | null = null;
let targetUrl = "";

function push(): void {
  void client
    ?.push(content.value)
    .catch((e) => console.warn("TeleCanvas push error (invalid URL / unreachable):", e));
}

// Apply a fresh target from main. Always push — even when the URL string is
// UNCHANGED (a host respawn re-announces the same target) — so the fresh
// server's empty buffer is refilled with the current content.
function applyTarget(t: TeleCanvasTarget): void {
  const url = teleCanvasTarget(t);
  if (url !== targetUrl) {
    targetUrl = url;
    client = url ? new TeleCanvasClient(url) : null;
  }
  push();
}

let disposeTarget: (() => void) | null = null;
onMounted(async () => {
  // Subscribe BEFORE the seed await — a broadcast landing in that gap would
  // otherwise be missed (self-healing on the next one, but why race at all).
  disposeTarget = window.foveaBridge.onTeleCanvasTarget(applyTarget);
  try {
    applyTarget(await window.foveaBridge.getTeleCanvasTarget());
  } catch {
    applyTarget(IDLE_TELECANVAS_TARGET); // idle default until the first broadcast
  }
});

// Push whenever the local provider content changes (markers moving, etc.).
watch(content, push);
onUnmounted(() => {
  disposeTarget?.();
  client = null;
});
</script>

<template>
  <!-- renders nothing -->
</template>
