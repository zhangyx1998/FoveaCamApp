<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Debug sub-window (WS2 2b): carries a module's annotation overlay OFF the main
  canvas into its own owner-bound window (cascade-closes with the opener app).
  Passively subscribes to the module's real contract (frame + typed telemetry)
  and draws the registered overlay component over the frame — the same overlay
  the main view renders (A-P6: overlay is a shared component now). The
  session/frame address rides the URL like a projection window; the overlay is
  picked from `debug-registry` by session name.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useSession } from "@lib/orchestrator/client";
import TitleBar from "../components/TitleBar.vue";
import StreamView from "../components/StreamView.vue";
import { debugOverlayFor } from "./debug-registry";

const props = defineProps<{ session: string; frame: string }>();
const titleBarHeight = ref(0);

const overlay = debugOverlayFor(props.session);
const valid = computed(() => !!props.session && !!props.frame && !!overlay);

// Passive subscription to the module contract — never activates the session
// (the app owns it); the overlay component reads its typed telemetry. Static
// per window (session/frame/contract don't change), like ProjectionWindow.
const source =
  overlay && props.session && props.frame
    ? useSession(overlay.contract, props.session, { passive: true })
    : null;
const payload = computed(() => source?.frame(props.frame).payload.value ?? null);
const address = computed(() =>
  source ? { session: props.session, frame: props.frame } : null,
);
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <div v-if="!valid" class="notice">No debug overlay registered for "{{ session }}"</div>
    <template v-else>
      <StreamView
        class="stream"
        :payload="payload"
        :source="address"
        :projectable="false"
        width="100%"
        height="100%"
      >
        <component :is="overlay!.component" :session="source" />
      </StreamView>
      <div v-if="!payload" class="notice">Waiting for {{ session }} / {{ frame }}…</div>
    </template>
  </div>
  <TitleBar
    title="Debug"
    :subtitle="`${session} / ${frame}`"
    @height="(h) => (titleBarHeight = h)"
  />
</template>

<style scoped lang="scss">
.main {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  * {
    user-select: none;
  }
}

.stream {
  width: 100%;
  height: 100%;
}

.notice {
  color: #888;
  font-size: 1.1em;
  text-align: center;
  padding: 2em;
}
</style>
