<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Welcome window (docs/refactor/multi-window.md req. 1 + 5): the launcher
  shown whenever no app window is open. One button per app (each opens its
  own window via the main-process window manager), orchestrator connection
  status, and a live camera preview annotated with basic camera params
  (resolution / fps / gain / exposure) on an SVG canvas.

  Data plumbing: everything shown is synced from the orchestrator — this
  reuses the manage-cameras session's read surface (per-serial `views`
  telemetry + per-serial preview frames) rather than inventing a second
  source of truth (§4). The subscription is ACTIVE, not passive: previews
  need the registry loop running, which makes welcome a camera-holding
  window — the welcome→app transition rides the same drain path as
  app→app switching (the window manager drains sessions before spawning).

  Annotation positions are meant to be HAND-EDITED here (one <Annotation>
  element per datum, stable ids, x/y in percent) — do not add layout logic.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useSession } from "@lib/orchestrator/client";
import { manageCameras } from "@modules/manage-cameras/contract";
import { APPS } from "@lib/windows";
import TitleBar from "../components/TitleBar.vue";
import StreamView from "../components/StreamView.vue";
import AnnotationCanvas from "./AnnotationCanvas.vue";
import Annotation from "./Annotation.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faCameraAlt,
  faCameraRotate,
  faChartLine,
  faCircleHalfStroke,
  faCompass,
  faFlagCheckered,
  faGears,
  faObjectGroup,
  faObjectUngroup,
  faRulerCombined,
} from "./icons";

const titleBarHeight = ref(0);

const session = useSession(manageCameras, "manage-cameras");
onMounted(() => session.call("refresh", undefined));

// Orchestrator connection status: down-notice from main + list presence.
const orchestratorDown = ref(false);
window.foveaBridge.onOrchestratorDown(() => (orchestratorDown.value = true));
const status = computed(() => {
  if (orchestratorDown.value) return "orchestrator down";
  const n = session.telemetry.list.length;
  return n > 0 ? `connected — ${n} camera${n > 1 ? "s" : ""}` : "no cameras";
});

// Previewed camera: prefer the center (role C) camera, else the first one.
const selectedSerial = ref<string | null>(null);
const serial = computed(() => {
  if (selectedSerial.value) return selectedSerial.value;
  const views = session.telemetry.views;
  for (const [s, v] of Object.entries(views)) if (v.role === "C") return s;
  return session.telemetry.list[0]?.serial ?? null;
});
const view = computed(() =>
  serial.value ? session.telemetry.views[serial.value] : undefined,
);
const payload = computed(() =>
  serial.value ? session.frame(serial.value).value : null,
);

// Annotation values (all orchestrator-synced; resolution from the live frame).
const fmt = (v: number | undefined, digits = 1) =>
  v === undefined ? "—" : v.toFixed(digits);
const resolution = computed(() => {
  const shape = payload.value?.shape;
  return shape ? `${shape[1]} × ${shape[0]}` : "—";
});
const frameRate = computed(() =>
  view.value?.frame_rate_enable
    ? `${fmt(view.value.frame_rate)} fps`
    : `${fmt(view.value?.frame_rate)} fps (free-run)`,
);
const exposure = computed(() => `${fmt(view.value?.exposure, 0)} µs`);
const gain = computed(() => `${fmt(view.value?.gain)} dB`);

// Launcher entries — dev-only apps hidden in production builds.
const launchable = APPS.filter((a) => !a.dev || import.meta.env.DEV);
const applications = launchable.filter((a) => a.group === "application");
const utilities = launchable.filter((a) => a.group === "utility");

const iconOf: Record<string, object> = {
  "disparity-scope": faCircleHalfStroke,
  "tracking-single": faObjectGroup,
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
function openProfiler() {
  window.foveaBridge.openProfilerWindow();
}
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <div class="preview-pane">
      <div class="preview">
        <StreamView v-if="payload" :payload="payload" />
        <div v-else class="no-preview">
          <img src="/FoveaCam Duo Mini.png" style="max-width: 50%" />
          <h1>FoveaCam Duo Mini</h1>
        </div>
        <!-- One annotation per element; stable ids; x/y are percent of the
             preview area. USER-POSITIONED — edit x/y/dx/dy by hand here. -->
        <AnnotationCanvas v-if="payload">
          <Annotation id="ann-status" :x="4" :y="6" :dx="10" label="status" :value="status" />
          <Annotation id="ann-camera" :x="4" :y="14" :dx="10" label="camera" :value="view?.description ?? serial ?? '—'" />
          <Annotation id="ann-resolution" :x="4" :y="22" :dx="10" label="resolution" :value="resolution" />
          <Annotation id="ann-frame-rate" :x="4" :y="30" :dx="10" label="frame rate" :value="frameRate" />
          <Annotation id="ann-exposure" :x="4" :y="38" :dx="10" label="exposure" :value="exposure" />
          <Annotation id="ann-gain" :x="4" :y="46" :dx="10" label="gain" :value="gain" />
        </AnnotationCanvas>
      </div>
      <div class="status-row">
        <span class="dot" :class="{ ok: !orchestratorDown && session.telemetry.list.length > 0 }"></span>
        <span>{{ status }}</span>
        <select v-if="session.telemetry.list.length > 1" v-model="selectedSerial">
          <option :value="null">auto (center)</option>
          <option v-for="c in session.telemetry.list" :key="c.serial" :value="c.serial">
            {{ c.serial }}
          </option>
        </select>
      </div>
    </div>
    <div class="modules">
      <div class="group">
        <h2>Applications</h2>
        <button
          v-for="a in applications"
          :key="a.id"
          :style="{ '--color': a.dev ? '#f6f' : '#0af' }"
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
          style="--color: #fa0"
          @click="open(a.id)"
        >
          <Icon :icon="iconOf[a.id]" /> {{ a.title }}
        </button>
        <button style="--color: #af0" @click="openProfiler">
          <Icon :icon="faChartLine" /> Profiler
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
  background-color: #222;

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
    h1 {
      font-size: 2rem;
      font-weight: normal;
      color: #ccc;
    }
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 1ch;
    color: #bbb;
    padding: 0.6em 1em;
    border-top: 1px solid #fff2;
    font-size: 0.9em;

    .dot {
      width: 0.7em;
      height: 0.7em;
      border-radius: 50%;
      background: #a33;
      &.ok {
        background: #3a3;
      }
    }

    select {
      margin-left: auto;
      background: #111;
      color: #ccc;
      border: 1px solid #444;
      border-radius: 3px;
    }
  }
}

.modules {
  background-color: #1a1a1a;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  min-width: 32ch;
  border-left: 1px solid #fff4;
  overflow-y: auto;
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

    &:hover {
      filter: saturate(1);
      border-left: 0.8ch solid var(--color);
      background-color: #fff1;
    }

    &:active {
      filter: saturate(1);
      border-left: 0.8ch solid var(--color);
      background-color: #fff2;
    }
  }

  .footnote {
    color: #666;
    text-align: center;
    padding: 1em 0;
  }
}
</style>
