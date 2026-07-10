<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  App-wide Settings window shell (singleton; "Settings…" menu / Cmd+,). This is
  the window ROOT, so it must NOT use top-level await itself (no <Suspense>
  parent) — it wraps the async `ConfigBody` (which awaits the config store) in a
  <Suspense> with the shared Loading fallback, mirroring AppWindow's pattern.
-->
<script setup lang="ts">
import { ref } from "vue";
import TitleBar from "../components/TitleBar.vue";
import Loading from "../components/Loading.vue";
import ConfigBody from "./ConfigBody.vue";

const titleBarHeight = ref(0);
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <Suspense>
      <ConfigBody />
      <template #fallback><Loading /></template>
    </Suspense>
  </div>
  <TitleBar title="Settings" @height="(h) => (titleBarHeight = h)" />
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
