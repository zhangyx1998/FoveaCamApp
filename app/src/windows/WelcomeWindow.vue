<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Welcome window (docs/history/refactor/multi-window.md req. 1 + 5): the launcher
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

  Annotation geometry + labels live in `welcome-canvas.svg` (plain SVG, meant
  to be HAND-EDITED / rearranged in an SVG editor — see the contract comment
  at its top). This component only injects live values: elements with
  `id="ann-*-value"` get their textContent set from the computeds below —
  do not add layout logic on either side.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from "vue";
import { usePipeFrame, useSession } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { manageCameras } from "@modules/manage-cameras/contract";
import { launchableApps } from "./app-registry";
import TitleBar from "../components/TitleBar.vue";
import StreamView from "../components/StreamView.vue";
import WelcomeCanvas from "./welcome-canvas.svg";
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
const orchDown = ref(false);
window.foveaBridge.onOrchestratorDown(() => (orchDown.value = true));
const status = computed(() => {
  if (orchDown.value) return "orchestrator down";
  const n = session.telemetry.list.length;
  return n > 0 ? `connected — ${n} camera${n > 1 ? "s" : ""}` : "no cameras";
});

// Previewed camera: prefer the center (role C) camera, else the first one.
const serialPick = ref<string | null>(null);
const serial = computed(() => {
  if (serialPick.value) return serialPick.value;
  const views = session.telemetry.views;
  for (const [s, v] of Object.entries(views)) if (v.role === "C") return s;
  return session.telemetry.list[0]?.serial ?? null;
});
const view = computed(() =>
  serial.value ? session.telemetry.views[serial.value] : undefined,
);
// real-1c: annotated preview off the selected camera's native pipe.
const payload = usePipeFrame(() => (serial.value ? nodeId.convert(serial.value) : null));

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

// Live-value injection into the externalized SVG canvas (welcome-canvas.svg):
// one entry per annotation group; the target element is `<text id="ann-*
// -value">`. The svg-loader build step suffixes ids with a scope hash, so we
// match by PREFIX — the ids spelled in the .svg file stay the contract.
const annotationLayer = ref<HTMLElement | null>(null);
const annotationValues = computed<Record<string, string>>(() => ({
  "ann-status": status.value,
  "ann-camera": view.value?.description ?? serial.value ?? "—",
  "ann-resolution": resolution.value,
  "ann-frame-rate": frameRate.value,
  "ann-exposure": exposure.value,
  "ann-gain": gain.value,
}));
watchEffect(
  () => {
    const layer = annotationLayer.value;
    if (!layer) return; // v-if="payload" not mounted yet
    for (const [id, text] of Object.entries(annotationValues.value)) {
      const el = layer.querySelector(`[id^="${id}-value"]`);
      if (el) el.textContent = text;
    }
  },
  // flush post: run after the v-if mounts/replaces the SVG subtree.
  { flush: "post" },
);

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
function openProfiler() {
  window.foveaBridge.openProfilerWindow();
}
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <div class="preview-pane">
      <div class="preview">
        <div class="no-preview">
          <img src="/FoveaCam Duo Mini.png" style="max-width: 75%" />
        </div>
        <!-- Externalized annotation canvas: geometry/labels are hand-edited
             in welcome-canvas.svg; live values are injected by id (see the
             watchEffect above). -->
        <div v-if="payload" ref="annotationLayer" class="annotation-layer">
          <WelcomeCanvas class="annotation-canvas" />
        </div>
      </div>
      <div class="status-row">
        <span
          class="dot"
          :class="{ ok: !orchDown && session.telemetry.list.length > 0 }"
        ></span>
        <span>{{ status }}</span>
        <select v-if="session.telemetry.list.length > 1" v-model="serialPick">
          <option :value="null">auto (center)</option>
          <option
            v-for="c in session.telemetry.list"
            :key="c.serial"
            :value="c.serial"
          >
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
  background-color: var(--bg-app);

  .preview {
    position: relative;
    flex-grow: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .annotation-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: visible;

    .annotation-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
  }

  .no-preview {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2em;
    h1 {
      font-size: 2rem;
      font-weight: normal;
      color: var(--text-dim);
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

    select {
      margin-left: auto;
      background: var(--bg-chrome);
      color: var(--text-dim);
      border: 1px solid var(--border-strong);
      border-radius: 3px;
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
