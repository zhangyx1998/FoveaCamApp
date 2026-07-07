<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Per-app window shell (docs/refactor/multi-window.md req. 2): one app per
  window, identity derived from the entry URL by app-window.ts and passed in
  as a prop. Replaces the old single-window App.vue module switcher — the
  title-bar chrome (RecordButton / capture overlay / RemoteCanvas / profiler
  / Controller) is ported from it unchanged; "Back to Home" now closes this
  window, which lets the main-process welcome rule respawn the launcher.
-->
<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";
import TitleBar from "../components/TitleBar.vue";
import Controller from "../components/Controller.vue";
import Loading from "../components/Loading.vue";
import ErrorBoundary from "../components/ErrorBoundary.vue";
import SessionStatus from "../components/SessionStatus.vue";
import Overlay, { overlay } from "../components/Overlay.vue";
import RemoteCanvas from "../components/RemoteCanvas.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faCamera, faTelevision, faChartLine } from "./icons";
import { current_capture } from "../capture";
import CaptureOverlay from "../capture/index.vue";
import RecordButton from "../record/RecordButton.vue";
import { appRegistry } from "./app-registry";

const props = defineProps<{ appId: string }>();

const meta = appRegistry[props.appId];
const moduleComponent = meta ? defineAsyncComponent(meta.loader) : null;

const titleBarHeight = ref(0);
const isCapAvailable = computed(() => current_capture.value !== null);

function openProfiler() {
  window.foveaBridge.openProfilerWindow();
}

// "Back to Home": in the multi-window world home is the welcome window —
// closing this window makes the main-process welcome rule respawn it.
function backToHome() {
  window.close();
}

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (isCapAvailable.value && overlay.value === null) {
      overlay.value = { overlay: CaptureOverlay };
    }
  }
});
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <SessionStatus :name="meta?.session" />
    <ErrorBoundary v-if="moduleComponent">
      <suspense>
        <component :is="moduleComponent" />
        <template #fallback>
          <Loading />
        </template>
      </suspense>
    </ErrorBoundary>
    <div v-else class="unknown-app">Unknown app: {{ appId }}</div>
  </div>
  <TitleBar
    title="FoveaCam Duo"
    :subtitle="meta?.title ?? appId"
    @height="(h) => (titleBarHeight = h)"
    @back-to-home="backToHome"
  >
    <RecordButton />
    <Overlay :overlay="CaptureOverlay" :disabled="!isCapAvailable">
      <Icon :icon="faCamera" />
    </Overlay>
    <Overlay :overlay="RemoteCanvas">
      <Icon :icon="faTelevision" />
    </Overlay>
    <button class="icon-button" title="Open profiler window" @click="openProfiler">
      <Icon :icon="faChartLine" />
    </button>
    <Controller />
  </TitleBar>
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

.unknown-app {
  color: #999;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 1.2em;
}

// Mirrors `Overlay.vue`'s `.overlay-toggle` so plain (non-overlay) title-bar
// icon buttons look consistent with the ones next to it (ported from App.vue).
.icon-button {
  background: none;
  border: none;
  padding: 0.4em;
  margin: 0;
  cursor: pointer;
  color: inherit;
  border-radius: 4px;
  transition: all 0.1s;
  outline: 1px solid transparent;

  &:hover {
    background: #fff1;
    outline: 1px solid #666;
  }
}
</style>
