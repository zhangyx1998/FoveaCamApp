<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Per-app window shell (docs/history/refactor/multi-window.md req. 2): one app per
  window, identity derived from the entry URL by app-window.ts and passed in
  as a prop. Replaces the old single-window App.vue module switcher — the
  title-bar chrome (RecordButton / capture overlay / RemoteCanvas / profiler
  / Controller) is ported from it unchanged; "Back to Home" now closes this
  window, which lets the main-process welcome rule respawn the launcher.
-->
<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import TitleBar from "../components/TitleBar.vue";
import Controller from "../components/Controller.vue";
import Loading from "../components/Loading.vue";
import ErrorBoundary from "../components/ErrorBoundary.vue";
import SessionStatus from "../components/SessionStatus.vue";
import ProgressMonitor from "../components/ProgressMonitor.vue";
import CrashReport from "../components/CrashReport.vue";
import { useSessionStatus } from "@lib/orchestrator/client";
import Overlay, { overlay } from "../components/Overlay.vue";
import RemoteCanvas from "../components/RemoteCanvas.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faCamera, faTelevision, faChartLine } from "./icons";
import { current_capture } from "../capture";
import RecordButton from "../record/RecordButton.vue";
import { appRegistry } from "./app-registry";

const props = defineProps<{ appId: string }>();

const meta = appRegistry[props.appId];
const moduleComponent = meta ? defineAsyncComponent(meta.loader) : null;
const session = meta?.session ?? null;

const titleBarHeight = ref(0);
const isCapAvailable = computed(() => current_capture.value !== null);

// Spin-up progress overlay (ruling 2026-07-09): observe the hosted session's
// status generically (passive — the app's own module drives the active
// subscription that triggers activation). While the session reports an in-flight
// progress list AND the user hasn't dismissed it, cover the blank app area with
// the reusable ProgressMonitor. The dismiss RESETS whenever a NEW spin-up begins
// (progress transitions null → non-null), so dismissing a stale run never
// suppresses the next activation's overlay.
const sessionStatus = session ? useSessionStatus(session) : null;
const progressDismissed = ref(false);
watch(
  () => sessionStatus?.progress ?? null,
  (progress, prev) => {
    if (progress !== null && (prev === null || prev === undefined))
      progressDismissed.value = false;
  },
);
const showProgress = computed(
  () => !!sessionStatus?.progress && !progressDismissed.value,
);

function openProfiler() {
  window.foveaBridge.openProfilerWindow();
}

// Capture preview moved out of the title-bar overlay into its own `debug`-class
// window (capture-recorder-nodes.md ruling 8): the camera icon now TOGGLES that
// window (open-or-close) instead of flipping an in-window overlay. Gated on a
// live capture context (only manual-control constructs one) and the app's
// session name (the window resolves its module component from it).
function toggleCapture() {
  if (!isCapAvailable.value || !session) return;
  window.foveaBridge.toggleDebugWindow(session, "capture");
}

// "Back to Home": in the multi-window world home is the welcome window —
// closing this window makes the main-process welcome rule respawn it.
function backToHome() {
  window.close();
}

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    toggleCapture();
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
    <ProgressMonitor
      v-if="showProgress"
      :items="sessionStatus!.progress!"
      @close="progressDismissed = true"
    />
    <!-- Orchestrator crash banner (lifecycle ruling 4) — self-hiding on clean. -->
    <CrashReport />
  </div>
  <TitleBar
    title="FoveaCam Duo"
    :subtitle="meta?.title ?? appId"
    home-button
    @height="(h) => (titleBarHeight = h)"
    @back-to-home="backToHome"
  >
    <RecordButton />
    <button
      class="icon-button"
      title="Capture preview"
      :disabled="!isCapAvailable"
      @click="toggleCapture"
    >
      <Icon :icon="faCamera" />
    </button>
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
  color: var(--text-muted);
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

  &:not(:disabled):hover {
    background: var(--tint-1);
    outline: 1px solid var(--border-muted);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}
</style>
