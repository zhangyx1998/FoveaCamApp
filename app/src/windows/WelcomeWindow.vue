<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Welcome window — the launcher shown whenever no app window is open. One button
  per app (each opens its own window via the main-process window manager) plus a
  STATUS-ONLY panel: the logo, a connection status row, and the live camera list.

  Disposable-orchestrator ruling 3: Welcome is status-only. It no longer holds a
  camera-holding orchestrator session or a live preview — it opens/holds NO
  hardware, so entering an app never has to drain it (the old welcome→app drain
  is gone). Its data comes from the persistent enumerate-only PROBE process
  (orchestrator/probe.ts), forwarded by main over the `probe:cameras` bridge
  event. "orchestrator down" as a welcome state disappears — Welcome depends on
  no orchestrator; the status reflects the probe. The camera picker + live
  preview + annotation canvas are deleted.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { sortedCameras, welcomeStatus, type ProbeCamera } from "@lib/orchestrator/probe";
import { launchableApps } from "./app-registry";
import TitleBar from "../components/TitleBar.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faCameraAlt,
  faCameraRotate,
  faCircleHalfStroke,
  faCompass,
  faFlagCheckered,
  faGears,
  faObjectGroup,
  faObjectUngroup,
  faRulerCombined,
} from "./icons";

const titleBarHeight = ref(0);

// Live camera list from the enumerate-only probe (main → onProbeCameras). No
// orchestrator connection, no camera lease — just the plain enumerated list.
const cameras = ref<ProbeCamera[]>([]);
const probing = ref(false);
let disposeProbe: (() => void) | null = null;
onMounted(() => {
  disposeProbe = window.foveaBridge.onProbeCameras((list) => {
    cameras.value = list;
    probing.value = true; // first snapshot arrived — the probe is answering
  });
});
onUnmounted(() => disposeProbe?.());

const status = computed(() => welcomeStatus(cameras.value, probing.value));
const connected = computed(() => probing.value && cameras.value.length > 0);
const cameraList = computed(() => sortedCameras(cameras.value));

// Launcher entries — dev-only apps hidden in production builds.
const applications = launchableApps.filter((a) => a.group === "application");
const calibration = launchableApps.filter((a) => a.group === "calibration");
const utilities = launchableApps.filter((a) => a.group === "utility");

const iconOf: Record<string, object> = {
  "disparity-scope": faCircleHalfStroke,
  "multi-fovea": faObjectGroup,
  "manual-control": faCompass,
  "single-capture": faCameraAlt,
  playground: faObjectUngroup,
  "manage-cameras": faGears,
  "calibrate-intrinsic": faCameraAlt,
  "calibrate-extrinsic": faCameraRotate,
  "calibrate-distortion": faFlagCheckered,
  "calibrate-drift": faRulerCombined,
};

function open(appId: string) {
  window.foveaBridge.openAppWindow(appId);
}
function openConfig() {
  window.foveaBridge.openConfigWindow();
}
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <div class="preview-pane">
      <div class="preview">
        <div class="no-preview">
          <img src="/FoveaCam Duo Mini.png" style="max-width: 55%" />
        </div>
      </div>
      <div class="camera-list" v-if="cameraList.length > 0">
        <div class="camera" v-for="c in cameraList" :key="c.serial">
          <Icon :icon="faCameraAlt" class="cam-icon" />
          <span class="cam-role" v-if="c.role">{{ c.role }}</span>
          <span class="cam-name">{{ c.vendor }} {{ c.model }}</span>
          <span class="cam-serial">{{ c.serial }}</span>
        </div>
      </div>
      <div class="status-row">
        <span class="dot" :class="{ ok: connected }"></span>
        <span>{{ status }}</span>
      </div>
    </div>
    <div class="modules">
      <div class="group">
        <h2>Applications</h2>
        <button
          v-for="a in applications"
          :key="a.id"
          :style="{ '--color': a.dev ? '#f6f' : 'var(--accent-bright)' }"
          @click="open(a.id)"
        >
          <Icon :icon="iconOf[a.id]" /> {{ a.title }}
        </button>
      </div>
      <div class="group">
        <h2>Calibration</h2>
        <button
          v-for="a in calibration"
          :key="a.id"
          style="--color: var(--warn)"
          @click="open(a.id)"
        >
          <Icon :icon="iconOf[a.id]" /> {{ a.title }}
        </button>
      </div>
      <div class="group">
        <h2>Utilities</h2>
        <button
          v-for="a in utilities"
          :key="a.id"
          style="--color: var(--warn)"
          @click="open(a.id)"
        >
          <Icon :icon="iconOf[a.id]" /> {{ a.title }}
        </button>
        <button style="--color: var(--text-muted)" @click="openConfig">
          <Icon :icon="faGears" /> Settings
        </button>
      </div>
      <div style="flex-grow: 1"></div>
      <div class="footnote">Copyright © 2026 Yuxuan Zhang</div>
    </div>
  </div>
  <TitleBar title="FoveaCam Duo" @height="(h) => (titleBarHeight = h)" />
</template>

<style scoped lang="scss">
.main {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: row;
  overflow: hidden;
  * {
    user-select: none;
  }
}

.preview-pane {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-app);

  .preview {
    position: relative;
    flex-grow: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .no-preview {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2em;
  }

  .camera-list {
    display: flex;
    flex-direction: column;
    gap: 0.25em;
    padding: 0.6em 1em;
    border-top: 1px solid var(--tint-2);

    .camera {
      display: flex;
      align-items: center;
      gap: 1ch;
      color: var(--text-dim);
      font-size: 0.9em;

      .cam-icon {
        color: var(--ok);
      }
      .cam-role {
        font-weight: bold;
        color: var(--accent-bright);
        min-width: 1.5ch;
      }
      .cam-serial {
        margin-left: auto;
        color: var(--text-disabled);
        font-variant-numeric: tabular-nums;
      }
    }
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 1ch;
    color: var(--text-dim);
    padding: 0.6em 1em;
    border-top: 1px solid var(--tint-2);
    font-size: 0.9em;

    .dot {
      width: 0.7em;
      height: 0.7em;
      border-radius: 50%;
      background: var(--danger);
      &.ok {
        background: var(--ok);
      }
    }
  }
}

.modules {
  background-color: var(--bg-panel-alt);
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  min-width: 32ch;
  border-left: 1px solid var(--tint-4);
  overflow-y: auto;
  --color: white;

  .group {
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0;
    margin: 0.5rem 0;
    &:not(:first-child) {
      border-top: 1px solid var(--tint-4);
    }
    h2 {
      font-size: 1em;
      margin: 1rem 1.5rem;
      color: var(--text-dim);
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

    &:hover {
      filter: saturate(1);
      border-left: 0.8ch solid var(--color);
      background-color: var(--tint-1);
    }

    &:active {
      filter: saturate(1);
      border-left: 0.8ch solid var(--color);
      background-color: var(--tint-2);
    }
  }

  .footnote {
    color: var(--text-disabled);
    text-align: center;
    padding: 1em 0;
  }
}
</style>
