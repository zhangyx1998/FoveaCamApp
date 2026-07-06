<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<script setup lang="ts">
import { computed, defineAsyncComponent, ref, shallowRef } from "vue";
import TitleBar from "./components/TitleBar.vue";
import Controller from "./components/Controller.vue";
const currentModule = shallowRef<any>(null);
const currentModuleName = ref<string | null>(null);
const titleBarHeight = ref(0);
// Sub task modules
import ManualControl from "../modules/manual-control/index.vue";
import TrackingSingle from "../modules/tracking-single/index.vue";
import MultiFovea from "../modules/multi-fovea/index.vue";
import DisparityScope from "../modules/disparity-scope/index.vue";
import ManageCameras from "../modules/manage-cameras/index.vue";
import CalibrateIntrinsic from "../modules/calibrate-intrinsic/index.vue";
import CalibrateExtrinsic from "../modules/calibrate-extrinsic/index.vue";
import CalibrateDistortion from "../modules/calibrate-distortion/index.vue";
import CalibrateDrift from "../modules/calibrate-drift/index.vue";
import SingleCapture from "../modules/single-capture/index.vue";
// Dev-only scratch module — the last renderer code still touching `core`
// directly (docs/refactor/orchestrator.md §7.1 S1c). Quarantined rather than
// migrated: gated on `import.meta.env.DEV` so a production build's dead-code
// elimination drops the import (and its `core` dependency) entirely instead
// of just lazy-loading it.
const Playground = import.meta.env.DEV
  ? defineAsyncComponent(() => import("../modules/playground/index.vue"))
  : null;
import Loading from "./components/Loading.vue";
import ErrorBoundary from "./components/ErrorBoundary.vue";
import Overlay, { overlay } from "./components/Overlay.vue";
import RemoteCanvas from "./components/RemoteCanvas.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faCamera,
  faCompass,
  faObjectGroup,
  faObjectUngroup,
} from "@fortawesome/free-regular-svg-icons";
import {
  faTelevision,
  faGears,
  faFlagCheckered,
  faCameraRotate,
  faCameraAlt,
  faRulerCombined,
  faBookOpen,
  faCircleHalfStroke,
  faChartLine,
} from "@fortawesome/free-solid-svg-icons";
import { current_capture } from "./capture";
import CaptureOverlay from "./capture/index.vue";
import RecordButton from "./record/RecordButton.vue";

const isCapAvailable = computed(() => current_capture.value !== null);

function launch(module: any, name: string) {
  currentModule.value = module;
  currentModuleName.value = name;
}

function backToHome() {
  currentModule.value = null;
  currentModuleName.value = null;
}

// Open the profiler window (docs/refactor/orchestrator.md §7.1 S4) — a
// second, plain-chrome window over the same orchestrator connection.
function openProfiler() {
  window.foveaBridge.openProfilerWindow();
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
    <template v-if="currentModule">
      <ErrorBoundary>
        <suspense>
          <component v-if="currentModule" :is="currentModule" />
          <template #fallback>
            <Loading />
          </template>
        </suspense>
      </ErrorBoundary>
    </template>
    <div v-else class="main-menu">
      <div class="welcome">
        <img
          src="/FoveaCam Duo Mini.png"
          style="width: max(40vw, 40vh, 80%); margin: 3em; max-width: 50vw"
        />
        <h1>FoveaCam Duo Mini</h1>
      </div>
      <div class="modules">
        <div class="group">
          <h2>Applications</h2>
          <button
            style="--color: #0af"
            @click="launch(DisparityScope, 'Disparity Scope')"
          >
            <Icon :icon="faCircleHalfStroke" /> Disparity Scope
          </button>
          <button
            style="--color: #0af"
            @click="launch(TrackingSingle, 'Object Tracking (Single)')"
          >
            <Icon :icon="faObjectGroup" /> Object Tracking (Single)
          </button>
          <button
            style="--color: #0af"
            @click="launch(MultiFovea, 'Object Tracking (Multi)')"
          >
            <Icon :icon="faObjectGroup" /> Object Tracking (Multi)
          </button>
          <button style="--color: #0af" disabled>
            <Icon :icon="faObjectGroup" /> 3D Reconstruction
          </button>
          <button
            style="--color: #0af"
            @click="launch(ManualControl, 'Manual Control')"
          >
            <Icon :icon="faCompass" /> Manual Control
          </button>
          <button
            v-if="Playground"
            style="--color: #f6f"
            @click="launch(Playground, 'Playground')"
          >
            <Icon :icon="faObjectUngroup" /> Playground
          </button>
          <button
            style="--color: #f6f"
            @click="launch(SingleCapture, 'Single Capture')"
          >
            <Icon :icon="faCameraAlt" /> Single Capture
          </button>
        </div>
        <div class="group">
          <h2>Utilities</h2>
          <button
            style="--color: #af0"
            @click="launch(ManageCameras, 'Manage Cameras')"
          >
            <Icon :icon="faGears" /> Manage Cameras
          </button>
          <button
            style="--color: #fa0"
            @click="launch(CalibrateIntrinsic, 'Calibrate Intrinsic')"
          >
            <Icon :icon="faCameraAlt" /> Calibrate Intrinsic
          </button>
          <button
            style="--color: #fa0"
            @click="launch(CalibrateExtrinsic, 'Calibrate Extrinsic')"
          >
            <Icon :icon="faCameraRotate" /> Calibrate Extrinsic
          </button>
          <button
            style="--color: #fa0"
            @click="launch(CalibrateDistortion, 'Calibrate Distortion')"
          >
            <Icon :icon="faFlagCheckered" /> Calibrate Distortion
          </button>
          <button
            style="--color: #fa0"
            @click="launch(CalibrateDrift, 'Calibrate Drift')"
          >
            <Icon :icon="faRulerCombined" /> Calibrate Drift
          </button>
          <button style="--color: #af0" disabled>
            <Icon :icon="faBookOpen" /> Manage Calibrations
          </button>
        </div>
        <div style="flex-grow: 1"></div>
        <div class="footnote">Copyright © 2025 Yuxuan Zhang</div>
      </div>
    </div>
  </div>
  <TitleBar
    title="FoveaCam Duo"
    :subtitle="currentModuleName"
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

// Mirrors `Overlay.vue`'s `.overlay-toggle` so plain (non-overlay) title-bar
// icon buttons look consistent with the ones next to it.
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

.main-menu {
  display: flex;
  flex-direction: row;
  align-items: center;
  overflow: hidden;
  width: 100%;
  height: 100%;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    Oxygen,
    Ubuntu,
    Cantarell,
    "Open Sans",
    "Helvetica Neue",
    sans-serif;

  h1 {
    font-size: 2rem;
    font-weight: normal;
    color: #ccc;
    width: 100%;
    text-align: center;
    margin: 0;
    padding: 0;
  }

  .welcome {
    height: 100%;
    flex-grow: 1;
    background-color: #222;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  .modules {
    background-color: #1a1a1a;
    display: flex;
    height: 100%;
    flex-direction: column;
    justify-content: flex-start;
    min-width: 32ch;
    border-left: 1px solid #fff4;
    --color: white;
    .group {
      display: flex;
      flex-direction: column;
      padding: 0.5rem 0;
      margin: 0.5rem 0;
      &:not(:first-child) {
        border-top: 1px solid #fff4;
      }
      h2 {
        font-size: 1em;
        margin: 1rem 1.5rem;
        padding: unset;
        color: #ccc;
        font-weight: bolder;
      }
    }

    button {
      font-size: 1.2em;
      padding: 0.5em 0.8em;
      background: none;
      border: none;
      color: var(--color);
      filter: saturate(0.6);
      cursor: pointer;
      min-width: 12ch;
      text-align: left;
      font-family: inherit;
      font-weight: 500;
      border-left: 0.8ch solid transparent;

      &:not(:disabled):hover {
        filter: saturate(1);
        border-left: 0.8ch solid var(--color);
        background-color: #fff1;
      }

      &:not(:disabled):active {
        filter: saturate(1);
        border-left: 0.8ch solid var(--color);
        background-color: #fff2;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        border-left: 0.8ch solid transparent;
        background-color: unset;
      }
    }
  }
  .footnote {
    color: #666;
    text-align: center;
    padding: 1em 0;
  }
}
</style>
