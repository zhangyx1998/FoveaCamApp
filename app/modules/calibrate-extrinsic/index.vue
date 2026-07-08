<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Extrinsic calibration wizard, migrated to the orchestrator (docs/history/refactor/
  orchestrator.md §7.1 S1b — the largest migration in the roadmap). Thin
  client over the `calibrate-extrinsic` session: three marker trackers, a
  step-dependent actuation mode (CAL visual-servo / FIN static / PRV
  drag-test), and a captured-records list that persists across steps and
  restarts (server-side scratch store). `records` are plain point data, so
  the FIN review renders SVG-only overlays — no per-record images, same as
  the original.
-->
<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { ROLE, THEME } from "@lib/camera-config";
import { useAppConfig } from "@lib/config";
import { useController, useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { readUrlParam, writeUrlState } from "@lib/url-state";
import { degrees } from "@lib/util";
import type { Point2d } from "core/Geometry";
import { calibrateExtrinsic } from "./contract";
import StreamView from "@src/components/StreamView.vue";
import PosView, { type Pos } from "@src/components/PosView.vue";
import MarkerTargetInputs from "@src/components/MarkerTargetInputs.vue";
import Line2D from "@src/components/Line2D.vue";
import NavBack from "@src/components/NavBack.vue";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";
import Marker from "@src/graphics/Marker.vue";
import CrossHair from "@src/graphics/CrossHair.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import Drawer from "@src/components/Drawer.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faTrashCan } from "@fortawesome/free-regular-svg-icons";

const app_config = await useAppConfig();
const session = useSession(calibrateExtrinsic, "calibrate-extrinsic");
const ctrl = useController();
const { state, telemetry } = session;

// State-in-URL (multi-window.md req. 7): the wizard step is addressable —
// `?step=FIN` seeds the session once on load (the session/scratch store
// stays authoritative; the URL is just the address of that state), then the
// URL tracks every step change via history.replaceState, so a dev restart /
// manifest restore lands back on the same screen.
{
  const seed = readUrlParam("step");
  if (seed === "CAL" || seed === "FIN" || seed === "PRV")
    void session.call("setStep", { step: seed });
}
watchEffect(() => writeUrlState({ step: state.step }));

// C-22: raw L/C/R previews ride the native camera:<serial> pipe (off the JS
// view-tap loop); marker overlays draw client-side from telemetry.detection.
const pipe = (role: "L" | "C" | "R") =>
  usePipeFrame(() => (state.serials?.[role] ? nodeId.convert(state.serials[role]) : null));
const frameL = pipe("L");
const frameC = pipe("C");
const frameR = pipe("R");

const marker_size = computed(() => app_config.cal_marker_size_mm);
const marker_ratio = computed(() => app_config.cal_marker_ratio);
const center_marker_size = computed(() => marker_size.value * marker_ratio.value);

const canRecord = computed(
  () => ctrl.telemetry.connected && telemetry.detection.L && telemetry.detection.C && telemetry.detection.R,
);
const hover_record = ref<number | null>(null);

function setOverride(role: "left" | "right", p: Pos | null) {
  session.call("setOverride", { role, pos: p });
}
function printAngle(a: Point2d): string {
  return `X ${degrees(a.x).toFixed(2)}°, Y ${degrees(a.y).toFixed(2)}°`;
}

// PRV: drag on the center view tests the fitted regressions.
function onPrvCursor(c: (Point2d & { buttons: number }) | null) {
  if (c && (c.buttons & 1) !== 0) session.call("setPreviewTarget", { p: { x: c.x, y: c.y } });
}

// FIN review: records carry marker corner points but no frame image (same
// as the original — this screen is SVG-only). A fixed/normalized viewBox
// doesn't work since points are in absolute sensor pixels; fit the viewBox
// to each polygon's own bounding box (with padding) instead.
function bbox(points: Point2d[]): string {
  if (points.length === 0) return "0 0 1 1";
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = Math.max(x1 - x0, 1);
  const h = Math.max(y1 - y0, 1);
  const pad = Math.max(w, h) * 0.2;
  return `${x0 - pad} ${y0 - pad} ${w + pad * 2} ${h + pad * 2}`;
}
</script>

<template>
  <template v-if="state.step === 'CAL'">
    <div class="cameras">
      <div class="view">
        <StreamView class="stream" :title="ROLE.L" :payload="frameL" :theme="THEME.L">
          <circle
            v-for="(p, i) in telemetry.detection.L?.points ?? []"
            :key="i"
            :cx="p.x"
            :cy="p.y"
            r="4"
            :fill="THEME.L"
          />
        </StreamView>
        <MarkerTargetInputs :session="session" role="L" :detected="!!telemetry.detection.L" />
        <PosView
          v-if="ctrl.telemetry.connected"
          :pos="ctrl.telemetry.pos.left"
          :lim="ctrl.telemetry.dv"
          :color="THEME.L"
          style="width: 100%"
          :font-size="12"
          @select="(p) => setOverride('left', p)"
        >
          <Line2D
            :data="[...telemetry.records.map((r) => r.L.voltage), ctrl.telemetry.pos.left]"
            :focus="hover_record"
            :focus-color="THEME.L"
          />
        </PosView>
      </div>
      <div class="view">
        <StreamView class="stream" :title="ROLE.C" :payload="frameC" :theme="THEME.C">
          <circle
            v-for="(p, i) in telemetry.detection.C?.points ?? []"
            :key="i"
            :cx="p.x"
            :cy="p.y"
            r="4"
            :fill="THEME.C"
          />
        </StreamView>
        <MarkerTargetInputs :session="session" role="C" :detected="!!telemetry.detection.C" />
        <div class="actions">
          <button style="--color: #080" :disabled="!canRecord" @click="session.call('capture', undefined)">
            Capture
          </button>
          <button
            style="--color: #a00"
            :disabled="telemetry.records.length === 0"
            @click="session.call('clearRecords', undefined)"
          >
            Clear
          </button>
          <button
            style="--color: #08a"
            :disabled="telemetry.records.length === 0"
            @click="session.call('finalize', undefined)"
          >
            Finalize
          </button>
        </div>
        <div class="records monospace">
          <div
            v-for="(r, i) in [...telemetry.records.entries()].reverse()"
            :key="i"
            @mouseenter="hover_record = r[0]"
            @mouseleave="hover_record = null"
          >
            <div style="padding-left: 1ch">[{{ r[0].toString().padStart(2, "0") }}] {{ printAngle(r[1].C.angle) }}</div>
            <button @click="session.call('removeRecord', { index: r[0] })">
              <Icon :icon="faTrashCan" />
            </button>
          </div>
        </div>
      </div>
      <div class="view">
        <StreamView class="stream" :title="ROLE.R" :payload="frameR" :theme="THEME.R">
          <circle
            v-for="(p, i) in telemetry.detection.R?.points ?? []"
            :key="i"
            :cx="p.x"
            :cy="p.y"
            r="4"
            :fill="THEME.R"
          />
        </StreamView>
        <MarkerTargetInputs :session="session" role="R" :detected="!!telemetry.detection.R" />
        <PosView
          v-if="ctrl.telemetry.connected"
          :pos="ctrl.telemetry.pos.right"
          :lim="ctrl.telemetry.dv"
          :color="THEME.R"
          style="width: 100%"
          :font-size="12"
          @select="(p) => setOverride('right', p)"
        >
          <Line2D
            :data="[...telemetry.records.map((r) => r.R.voltage), ctrl.telemetry.pos.right]"
            :focus="hover_record"
            :focus-color="THEME.R"
          />
        </PosView>
      </div>
    </div>
    <Drawer>
      <div class="options fill">
        <RangeSlider v-model="app_config.cal_marker_size_mm" :min="10" :max="120" :neutral="60" :step="1">
          <span>Marker Size</span>
          <span>{{ app_config.cal_marker_size_mm.toFixed(1) }} mm</span>
        </RangeSlider>
        <RangeSlider v-model="app_config.cal_marker_ratio" :min="0.2" :max="1.2" :neutral="1.0" :step="0.02">
          <span>Center Marker</span>
          <span>{{ (app_config.cal_marker_ratio * 100).toFixed(0) }}%</span>
        </RangeSlider>
      </div>
    </Drawer>
    <RemoteCanvasTeleport>
      <CrossHair :cx="app_config.baseline_distance_mm / 2 + marker_size" :cy="center_marker_size" weight="2" />
      <Marker :id="state.targetId.L" :size="marker_size" :cx="-app_config.baseline_distance_mm / 2" />
      <Marker :id="state.targetId.R" :size="marker_size" :cx="app_config.baseline_distance_mm / 2" />
      <Marker :id="state.targetId.C" :size="center_marker_size" />
    </RemoteCanvasTeleport>
  </template>

  <div v-else-if="state.step === 'FIN'" class="finalize" style="padding-top: 4em">
    <template v-for="(r, i) in telemetry.records" :key="i">
      <div class="divider" v-if="i > 0"></div>
      <div class="record">
        <div class="frame-box">
          <span class="frame-title">{{ ROLE.L }}</span>
          <svg :viewBox="bbox(r.L.img_pts)" style="width: 100%; height: 100%">
            <polygon
              v-if="r.L.img_pts.length"
              :points="r.L.img_pts.map((p) => `${p.x},${p.y}`).join(' ')"
              fill="none"
              :stroke="THEME.L"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>
        <div class="frame-box">
          <span class="frame-title">{{ ROLE.C }}</span>
          <svg :viewBox="bbox(r.C.img_pts)" style="width: 100%; height: 100%">
            <polygon
              v-if="r.C.img_pts.length"
              :points="r.C.img_pts.map((p) => `${p.x},${p.y}`).join(' ')"
              fill="none"
              :stroke="THEME.C"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>
        <div class="frame-box">
          <span class="frame-title">{{ ROLE.R }}</span>
          <svg :viewBox="bbox(r.R.img_pts)" style="width: 100%; height: 100%">
            <polygon
              v-if="r.R.img_pts.length"
              :points="r.R.img_pts.map((p) => `${p.x},${p.y}`).join(' ')"
              fill="none"
              :stroke="THEME.R"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>
      </div>
    </template>
    <NavBack @back="session.call('setStep', { step: 'CAL' })">
      <span>Back to Calibration</span>
      <div style="flex-grow: 1"></div>
      <button :disabled="!telemetry.finalized" @click="session.call('setStep', { step: 'PRV' })">
        Preview Results
      </button>
      <button @click="session.call('confirm', undefined)">Confirm and Save</button>
    </NavBack>
  </div>

  <div v-else-if="state.step === 'PRV'" class="cameras">
    <div class="view">
      <StreamView class="stream" :title="ROLE.L" :payload="frameL" :theme="THEME.L" />
      <PosView :pos="telemetry.preview.pos.L" :lim="ctrl.telemetry.dv" :color="THEME.L" style="width: 100%" />
    </div>
    <div class="view">
      <StreamView class="stream" :title="ROLE.C" :payload="frameC" :theme="THEME.C" @mouse="onPrvCursor">
        <circle
          v-if="telemetry.preview.cursor_l"
          :cx="telemetry.preview.cursor_l.x"
          :cy="telemetry.preview.cursor_l.y"
          r="6"
          :fill="THEME.L"
        />
        <circle
          v-if="telemetry.preview.cursor_r"
          :cx="telemetry.preview.cursor_r.x"
          :cy="telemetry.preview.cursor_r.y"
          r="6"
          :fill="THEME.R"
        />
      </StreamView>
    </div>
    <div class="view">
      <StreamView class="stream" :title="ROLE.R" :payload="frameR" :theme="THEME.R" />
      <PosView :pos="telemetry.preview.pos.R" :lim="ctrl.telemetry.dv" :color="THEME.R" style="width: 100%" />
    </div>
    <NavBack @back="session.call('setStep', { step: 'FIN' })">
      <span>Back to Summarize</span>
      <div style="flex-grow: 1"></div>
      <button :disabled="telemetry.saved" @click="session.call('confirm', undefined)">Confirm and Save</button>
    </NavBack>
  </div>
</template>

<style scoped lang="scss">
.cameras {
  position: relative;
  display: flex;
  justify-content: space-evenly;
  flex-wrap: wrap;
  flex-direction: row;
  width: 100%;
  padding: 0.5em 0;
  margin: 0;

  & > * {
    width: 30vw;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
  }

  .stream {
    width: 30vw;
    height: 22.5vw;
  }
}

.actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 1rem;
  width: 100%;

  & > * {
    display: block;
    width: 0;
    flex-grow: 1;
    height: 2rem;
    background-color: var(--color, #888);
    border-radius: 0.2em;
    border: none;
    color: white;
    &:not(:disabled) {
      cursor: pointer;
      &:hover {
        filter: brightness(1.2);
      }
    }
    &:disabled {
      opacity: 0.5;
      filter: saturate(0.2);
      cursor: not-allowed;
    }
  }
}

.records {
  width: 100%;
  flex-grow: 1;
  overflow-y: scroll;
  margin: 0.5em 0;
  max-height: 25vw;
  & > * {
    height: 3em;
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    &:hover {
      background-color: #fff1;
    }
    button {
      background: none;
      border: none;
      color: #f66;
      cursor: pointer;
      font-size: 1.2em;
      padding: 0.2em;
      height: 3em;
      width: 3em;
    }
  }
  &,
  & > * {
    border-top: 1px solid #fff4;
    border-bottom: 1px solid #fff4;
  }
}

.finalize {
  width: 100%;
  max-height: 100%;
  overflow-y: scroll;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 2em;
  gap: 2em;
  box-sizing: border-box;

  .record {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-evenly;
    flex-grow: 1;
  }

  .frame-box {
    position: relative;
    width: 30%;
    aspect-ratio: 4 / 3;
    background: #111;
    outline: 1px solid #444;

    .frame-title {
      position: absolute;
      top: -1.6em;
      left: 0;
      font-size: 0.8em;
      color: gray;
    }
  }

  .divider {
    width: 100%;
    height: 1px;
    background-color: #333;
  }
}
</style>
