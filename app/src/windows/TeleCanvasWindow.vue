<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  TeleCanvas window shell (singleton; opened from the app title-bar TV icon).
  Like ConfigWindow, this is the window ROOT, so it must NOT use top-level await
  itself — it wraps the async `TeleCanvasBody` (which awaits the config store) in
  a <Suspense> with the shared Loading fallback.
-->
<script setup lang="ts">
import { ref } from "vue";
import TitleBar from "../components/TitleBar.vue";
import Loading from "../components/Loading.vue";
import ErrorBoundary from "../components/ErrorBoundary.vue";
import TeleCanvasBody from "./TeleCanvasBody.vue";

const titleBarHeight = ref(0);
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <!-- Async-setup rejections must be observable, not an infinite spinner
         (rig find 2026-07-11) — same boundary as ConfigWindow/AppWindow. -->
    <ErrorBoundary>
      <Suspense>
        <TeleCanvasBody />
        <template #fallback><Loading /></template>
      </Suspense>
    </ErrorBoundary>
  </div>
  <TitleBar title="TeleCanvas" @height="(h) => (titleBarHeight = h)" />
</template>

<style scoped lang="scss">
.main {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--bg-app);
  overflow: hidden;
  * {
    user-select: none;
  }
}
</style>
