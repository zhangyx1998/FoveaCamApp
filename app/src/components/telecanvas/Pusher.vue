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

  This component owns the async config (`await useAppConfig()` in <script setup>,
  which Vue's compiler transforms safely — see the old RemoteCanvas note), so
  AppWindow mounts it inside a <Suspense>. Pushes are coalesced to one animation
  frame so a burst of DOM mutations becomes a single PUT.
-->
<script setup lang="ts">
import { watch, onUnmounted } from "vue";
import { useAppConfig } from "@lib/config";
import { content } from "./registry";
import { DEFAULT_TELECANVAS_PORT } from "@lib/telecanvas";

const appConfig = await useAppConfig();

/** The active PUT target for the current mode, or "" when disabled. */
function target(): string {
  if ((appConfig.tele_canvas_mode ?? "client") === "host")
    return `http://127.0.0.1:${appConfig.tele_canvas_port ?? DEFAULT_TELECANVAS_PORT}/`;
  return appConfig.tele_canvas_url ?? "";
}

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
    void put(target(), content.value);
  });
}

watch(() => [target(), content.value] as const, schedule, { immediate: true });
onUnmounted(() => {
  if (scheduled) cancelAnimationFrame(scheduled);
});
</script>

<template>
  <!-- renders nothing -->
</template>
