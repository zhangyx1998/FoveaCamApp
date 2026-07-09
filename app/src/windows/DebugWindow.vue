<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Debug sub-window (WS2 2b): a thin shell that mounts a MODULE-OWNED debugger
  component full-window under the TitleBar (cascade-closes with the opener app).
  The component (resolved by `session` name via `debug-registry`) owns all its
  own subscriptions — passive contract, pipes, frames — so this shell stays
  contract-agnostic: it only resolves the loader and hosts it. `session` rides
  the URL like a projection window.
-->
<script setup lang="ts">
import { ref, shallowRef, watchEffect, type Component } from "vue";
import TitleBar from "../components/TitleBar.vue";
import { debugLoaderFor } from "./debug-registry";

const props = defineProps<{ session: string }>();
const titleBarHeight = ref(0);

// Resolve the module debugger by session name and lazy-load it (static per
// window — the session never changes once the window is open).
const component = shallowRef<Component | null>(null);
const loader = debugLoaderFor(props.session);
watchEffect(async () => {
  if (loader) component.value = (await loader()).default;
});
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <component :is="component" v-if="component" />
    <div v-else class="notice">No debugger registered for "{{ session }}"</div>
  </div>
  <TitleBar
    title="Debugger"
    :subtitle="session"
    @height="(h) => (titleBarHeight = h)"
  />
</template>

<style scoped lang="scss">
.main {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  overflow: auto;
  * {
    user-select: none;
  }
}

.notice {
  color: #888;
  font-size: 1.1em;
  text-align: center;
  padding: 2em;
}
</style>
