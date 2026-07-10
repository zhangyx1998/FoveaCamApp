<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  TeleCanvas PUSH (per app window). Renders nothing — it watches the merged
  provider `content` and PUTs it to the active TeleCanvas target on every change,
  exactly as the old RemoteCanvas overlay did, but always-on (not only while an
  overlay is open) and in BOTH modes:
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

  Pushes are coalesced to one animation frame so a burst of DOM mutations becomes
  a single PUT. AppWindow still mounts this under <Suspense> (harmless — the async
  work is in onMounted now, not a top-level await).
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { content } from "./registry";
import {
  IDLE_TELECANVAS_TARGET,
  teleCanvasTarget,
  type TeleCanvasTarget,
} from "@lib/telecanvas";

/** The active PUT target URL for the current mode, or "" when disabled. Seeded
 *  from main at mount, then updated on every broadcast. */
const target = ref<string>(teleCanvasTarget(IDLE_TELECANVAS_TARGET));

async function put(urlString: string, body: string): Promise<void> {
  if (!urlString) return; // empty target = disabled (client-mode "off")
  try {
    const url = new URL(urlString);
    const res = await fetch(url.href, { method: "PUT", body });
    if (!res.ok) console.warn("TeleCanvas push failed:", res.status);
  } catch (e) {
    console.warn("TeleCanvas push error (invalid URL / unreachable):", e);
  }
}

// Coalesce a burst of provider mutations (every DOM change currently re-PUTs)
// into ONE PUT per animation frame — minimal debounce, no behavioral surprise.
let scheduled = 0;
function schedule(): void {
  if (scheduled) return;
  scheduled = requestAnimationFrame(() => {
    scheduled = 0;
    void put(target.value, content.value);
  });
}

// Apply a fresh target from main. Always schedule a push — even when the URL
// string is UNCHANGED (a host respawn re-announces the same target) — so the
// fresh server's empty buffer is refilled with the current content.
function applyTarget(t: TeleCanvasTarget): void {
  target.value = teleCanvasTarget(t);
  schedule();
}

let disposeTarget: (() => void) | null = null;
onMounted(async () => {
  // Subscribe BEFORE the seed await — a broadcast landing in that gap would
  // otherwise be missed (self-healing on the next one, but why race at all).
  disposeTarget = window.foveaBridge.onTeleCanvasTarget(applyTarget);
  try {
    applyTarget(await window.foveaBridge.getTeleCanvasTarget());
  } catch {
    /* keep the idle default until the first broadcast */
  }
});

// Push whenever the local provider content changes (markers moving, etc.).
watch(content, schedule);
onUnmounted(() => {
  disposeTarget?.();
  if (scheduled) cancelAnimationFrame(scheduled);
});
</script>

<template>
  <!-- renders nothing -->
</template>
