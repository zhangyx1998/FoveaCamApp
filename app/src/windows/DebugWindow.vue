<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Debug sub-window: a thin shell that mounts a MODULE-OWNED component
  full-window under the TitleBar (cascade-closes with the opener app). The
  component (resolved by `(kind, session)` via `debug-registry`) owns all its
  own subscriptions — passive contract, pipes, frames — so this shell stays
  contract-agnostic: it only resolves the loader and hosts it. `session` +
  `kind` ride the URL like a projection window. `kind` (default `debugger`)
  lets one session host both its debugger and its capture-preview window.
-->
<script setup lang="ts">
import { computed, ref, shallowRef, watchEffect, type Component } from "vue";
import TitleBar from "../components/TitleBar.vue";
import CrashReport from "../components/CrashReport.vue";
import { asDebugKind, debugKindTitle, debugLoaderFor } from "./debug-registry";

const props = defineProps<{ session: string; kind?: string }>();
const titleBarHeight = ref(0);
const kind = computed(() => asDebugKind(props.kind));

// Resolve the module component by (kind, session) and lazy-load it (static per
// window — neither the session nor the kind changes once the window is open).
const component = shallowRef<Component | null>(null);
const loader = debugLoaderFor(kind.value, props.session);
watchEffect(async () => {
  if (loader) component.value = (await loader()).default;
});
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <component :is="component" v-if="component" />
    <div v-else class="notice">
      No {{ kind }} registered for "{{ session }}"
    </div>
    <!-- Owned sub-window of the app: surface the same orchestrator crash banner. -->
    <CrashReport />
  </div>
  <TitleBar
    :title="debugKindTitle(kind)"
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
  color: var(--text-faint);
  font-size: 1.1em;
  text-align: center;
  padding: 2em;
}
</style>
