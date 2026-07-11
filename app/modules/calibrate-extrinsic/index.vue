<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Extrinsic calibration wizard — a thin client over the `calibrate-extrinsic`
  session (three marker trackers, step-dependent actuation, a persisted records
  list; FIN review is SVG-only). Behavior spec: docs/spec/calibrate-extrinsic.md.
-->
<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { ROLE, THEME } from "@lib/camera-config";
import { useAppConfig } from "@lib/config";
import { useTripleBaseline } from "@lib/triple-baseline";
import { useController, useSession, usePipeFrame, usePidOverride } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { readUrlParam, writeUrlState } from "@lib/url-state";
import { degrees } from "@lib/util";
import type { Point2d } from "core/Geometry";
import { calibrateExtrinsic } from "./contract";
import Recording from "@src/record";
import Capture from "@src/capture";
import StreamView from "@src/components/StreamView.vue";
import CalibrationMarks from "@src/components/CalibrationMarks.vue";
import Store from "@lib/store";
import { EXTRINSIC_STORE, type CalibrationRecord } from "@lib/calibration-records";
import type { ExtrinsicDataset } from "@lib/camera-config";
import {
  OVERLAY_DOC,
  OVERLAY_OFF,
  overlayActiveForRole,
  type OverlayState,
} from "@lib/calibration-overlay";
import PosView, { type Pos } from "@src/components/PosView.vue";
import MarkerDetection from "./MarkerDetection.vue";
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
const drawer_height = ref(0);
const session = useSession(calibrateExtrinsic, "calibrate-extrinsic");
const ctrl = useController();
const { state, telemetry } = session;
// Title-bar RecordButton + camera-icon Capture toggle (shared facades).
new Recording(session, "calibrate-extrinsic");
new Capture(session, "calibrate-extrinsic");

// State-in-URL: `?step=FIN` seeds the session once on load, then the URL tracks
// every step change (replaceState) so a restart lands on the same screen.
{
  const seed = readUrlParam("step");
  if (seed === "CAL" || seed === "FIN" || seed === "PRV")
    void session.call("setStep", { step: seed });
}
watchEffect(() => writeUrlState({ step: state.step }));

// Raw L/C/R previews ride the native camera:<serial> pipe; marker overlays draw
// client-side from telemetry.detection.
const pipe = (role: "L" | "C" | "R") =>
  usePipeFrame(() => (state.serials?.[role] ? nodeId.convert(state.serials[role]) : null));
const frameL = pipe("L");
const frameC = pipe("C");
const frameR = pipe("R");

const marker_size = computed(() => app_config.cal_marker_size_mm);
const marker_ratio = computed(() => app_config.cal_marker_ratio);

// Live extrinsic OVERLAY: a Settings toggle (main-backed store doc) draws a
// record's observed-vs-projected marks over the raw stream when it targets this
// eye. `img_points` are sensor pixels — the StreamView slot's coordinate space.
const overlayState = await Store.open<OverlayState, OverlayState>(OVERLAY_DOC, {
  ...OVERLAY_OFF,
});
const overlayRecord = ref<CalibrationRecord | null>(null);
watchEffect(async () => {
  const id = overlayState.recordId;
  overlayRecord.value = id
    ? await Store.read<CalibrationRecord | null>([EXTRINSIC_STORE, id], null)
    : null;
});
/** The extrinsic dataset to overlay for this eye, or null. Extrinsic-only (the
 *  overlay draws observed-vs-projected marks from an ExtrinsicDataset). */
function overlayFor(role: "L" | "R"): ExtrinsicDataset | null {
  const rec = overlayActiveForRole(overlayState, role) ? overlayRecord.value : null;
  return rec && rec.inner.kind === "extrinsic" ? rec.inner.dataset : null;
}
const center_marker_size = computed(() => marker_size.value * marker_ratio.value);
// Live per-triple baseline: the marker pair sits at ±baseline/2, resolved
// reactively from the triple's `baseline_mm` (legacy app value, else 200).
const baseline = useTripleBaseline(() => state.configPath, app_config);

// Review #12: capturable = detections present AND FRESH (a frozen tracker
// after camera loss must not stay capturable).
const canRecord = computed(
  () =>
    ctrl.telemetry.connected &&
    telemetry.detection.L && telemetry.detectionFresh.L &&
    telemetry.detection.C && telemetry.detectionFresh.C &&
    telemetry.detection.R && telemetry.detectionFresh.R,
);

// User issue 3: the PosView record head follows the LIVE applied mirror pose
// (session `mirror` telemetry, fed at a fixed throttle) — falls back to the
// controller session's last-published pose when the CAL feed isn't running.
const livePos = computed(() => telemetry.mirror ?? ctrl.telemetry.pos);

// User issue 1: the center marker's LOCKED-state crosshair anchors at the C
// detection's centroid (sensor px) — visible iff the tracker holds a target.
const centerLock = computed(() => {
  const d = telemetry.detection.C;
  if (!d || d.points.length === 0) return null;
  const q = d.points.slice(0, 4);
  return {
    x: q.reduce((a, p) => a + p.x, 0) / q.length,
    y: q.reduce((a, p) => a + p.y, 0) / q.length,
  };
});
const hover_record = ref<number | null>(null);

// Per-eye PID-node override proxies (CAL visual servo): dragging a PosView pins
// that eye's servo output; release emits null → the proxy releases (seeded resume).
const overrideL = usePidOverride<typeof calibrateExtrinsic, Pos>(session, {
  stateKey: "pidOverrideL",
  command: "pidOverrideL",
});
const overrideR = usePidOverride<typeof calibrateExtrinsic, Pos>(session, {
  stateKey: "pidOverrideR",
  command: "pidOverrideR",
});
function printAngle(a: Point2d): string {
  return `X ${degrees(a.x).toFixed(2)}°, Y ${degrees(a.y).toFixed(2)}°`;
}

// PRV: drag on the center view tests the fitted regressions.
function onPrvCursor(c: (Point2d & { buttons: number }) | null) {
  if (c && (c.buttons & 1) !== 0) session.call("setPreviewTarget", { p: { x: c.x, y: c.y } });
}

// FIN review is SVG-only (records carry points, no image). Points are absolute
// sensor px, so fit the viewBox to each polygon's own bounding box + padding.
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
    <!-- --p reserves the drawer's height below the content (manual-control
         idiom) so the fixed drawer never obscures the scrollable tail. -->
    <div
      class="cameras"
      :style="{ '--p': (drawer_height ? drawer_height + 20 : 0) + 'px' }"
    >
      <div class="view">
        <StreamView class="stream" :title="ROLE.L" :payload="frameL" :theme="THEME.L">
          <MarkerDetection
            v-if="telemetry.detection.L"
            :points="telemetry.detection.L.points"
            :id="state.targetId.L"
            :color="THEME.L"
          />
          <CalibrationMarks v-if="overlayFor('L')" :dataset="overlayFor('L')!" />
        </StreamView>
        <MarkerTargetInputs :session="session" role="L" :detected="!!telemetry.detection.L" />
        <PosView
          v-if="ctrl.telemetry.connected"
          :pos="livePos.left"
          :lim="ctrl.telemetry.dv"
          :color="THEME.L"
          style="width: 100%"
          :font-size="12"
          @select="(p) => (overrideL.value = p)"
        >
          <Line2D
            :data="[...telemetry.records.map((r) => r.L.voltage), livePos.left]"
            :focus="hover_record"
            :focus-color="THEME.L"
          />
        </PosView>
      </div>
      <div class="view">
        <StreamView class="stream" :title="ROLE.C" :payload="frameC" :theme="THEME.C">
          <MarkerDetection
            v-if="telemetry.detection.C"
            :points="telemetry.detection.C.points"
            :id="state.targetId.C"
            :color="THEME.C"
          />
          <!-- LOCKED-state crosshair (user issue 1): full-view cross through
               the tracked center marker — unmistakable lock feedback. -->
          <g v-if="centerLock" :transform="`translate(${centerLock.x}, ${centerLock.y})`">
            <CrossHair :cx="24" :cy="24" weight="2" :color="THEME.C" />
          </g>
        </StreamView>
        <MarkerTargetInputs :session="session" role="C" :detected="!!telemetry.detection.C" />
        <div class="actions">
          <button style="--color: var(--ok)" :disabled="!canRecord" @click="session.call('capture', undefined)">
            Capture
          </button>
          <button
            style="--color: var(--danger)"
            :disabled="telemetry.records.length === 0"
            @click="session.call('clearRecords', undefined)"
          >
            Clear
          </button>
          <button
            style="--color: var(--accent)"
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
          <MarkerDetection
            v-if="telemetry.detection.R"
            :points="telemetry.detection.R.points"
            :id="state.targetId.R"
            :color="THEME.R"
          />
          <CalibrationMarks v-if="overlayFor('R')" :dataset="overlayFor('R')!" />
        </StreamView>
        <MarkerTargetInputs :session="session" role="R" :detected="!!telemetry.detection.R" />
        <PosView
          v-if="ctrl.telemetry.connected"
          :pos="livePos.right"
          :lim="ctrl.telemetry.dv"
          :color="THEME.R"
          style="width: 100%"
          :font-size="12"
          @select="(p) => (overrideR.value = p)"
        >
          <Line2D
            :data="[...telemetry.records.map((r) => r.R.voltage), livePos.right]"
            :focus="hover_record"
            :focus-color="THEME.R"
          />
        </PosView>
      </div>
    </div>
    <Drawer v-model="drawer_height">
      <div class="options fill">
        <RangeSlider v-model="app_config.cal_marker_size_mm" :min="10" :max="120" :neutral="60" :step="1">
          <span>Marker Size</span>
          <span>{{ app_config.cal_marker_size_mm.toFixed(1) }} mm</span>
        </RangeSlider>
        <RangeSlider v-model="app_config.cal_marker_ratio" :min="0.2" :max="1.2" :neutral="1.0" :step="0.02">
          <span>Center Marker</span>
          <span>{{ (app_config.cal_marker_ratio * 100).toFixed(0) }}%</span>
        </RangeSlider>
        <!-- User issue 2: the CAL visual-servo gain, live (the session restarts
             the servo debounced; velocity-form — one real gain; see contract). -->
        <RangeSlider v-model="state.servoGain" :min="1" :max="64" :neutral="16" :step="1">
          <span>Servo Gain</span>
          <span>{{ state.servoGain.toFixed(0) }}</span>
        </RangeSlider>
      </div>
    </Drawer>
    <RemoteCanvasTeleport>
      <CrossHair :cx="baseline / 2 + marker_size" :cy="center_marker_size" weight="2" />
      <Marker :id="state.targetId.L" :size="marker_size" :cx="-baseline / 2" />
      <Marker :id="state.targetId.R" :size="marker_size" :cx="baseline / 2" />
      <Marker :id="state.targetId.C" :size="center_marker_size" />
    </RemoteCanvasTeleport>
  </template>

  <div v-else-if="state.step === 'FIN'" class="finalize" style="padding-top: 4em">
    <!-- Fit-quality header (review #14): pose count against the fit-gate
         minimum + per-eye RMS residuals of the fit that just ran. -->
    <div class="fit-quality monospace" v-if="telemetry.fin">
      <span :style="{ color: telemetry.fin.samples >= telemetry.fin.minSamples ? 'var(--ok)' : 'var(--danger-text)' }">
        {{ telemetry.fin.samples }} / {{ telemetry.fin.minSamples }} poses minimum
      </span>
      <span v-if="telemetry.fin.samples < telemetry.fin.minSamples">
        — capture more poses; the fit is gated below the minimum
      </span>
      <span v-else-if="telemetry.fin.rmsL !== null && telemetry.fin.rmsR !== null">
        · RMS residual L {{ telemetry.fin.rmsL.toFixed(3) }} V · R {{ telemetry.fin.rmsR.toFixed(3) }} V
      </span>
    </div>
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
        <!-- Per-record residual (review #14): volt distance between the fit's
             prediction at this record's angle and its RECORDED voltage. -->
        <div class="residual monospace" v-if="telemetry.fin?.residuals[i]">
          <template v-if="telemetry.fin.residuals[i].L !== null">
            ΔL {{ telemetry.fin.residuals[i].L!.toFixed(3) }} V
          </template>
          <template v-if="telemetry.fin.residuals[i].R !== null">
            · ΔR {{ telemetry.fin.residuals[i].R!.toFixed(3) }} V
          </template>
        </div>
      </div>
    </template>
    <NavBack @back="session.call('setStep', { step: 'CAL' })">
      <span>Back to Calibration</span>
      <div style="flex-grow: 1"></div>
      <button :disabled="!telemetry.finalized" @click="session.call('setStep', { step: 'PRV' })">
        Preview Results
      </button>
      <!-- Review #6: never saveable without a successful fit over captured
           records (the session gates the command identically). -->
      <button
        :disabled="!telemetry.finalized || telemetry.records.length === 0"
        @click="session.call('confirm', undefined)"
      >
        Confirm and Save
      </button>
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
  --p: 0; // drawer-height bottom reserve (bound inline from drawer_height)
  position: relative;
  display: flex;
  justify-content: space-evenly;
  flex-wrap: wrap;
  flex-direction: row;
  width: 100%;
  padding: 0.5em 0 calc(0.5em + var(--p)) 0;
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
    background-color: var(--color, var(--text-faint));
    border-radius: 0.2em;
    border: none;
    color: var(--text);
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
      background-color: var(--tint-1);
    }
    button {
      background: none;
      border: none;
      color: var(--danger-text);
      cursor: pointer;
      font-size: 1.2em;
      padding: 0.2em;
      height: 3em;
      width: 3em;
    }
  }
  &,
  & > * {
    border-top: 1px solid var(--tint-4);
    border-bottom: 1px solid var(--tint-4);
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
    background: var(--bg-chrome);
    outline: 1px solid var(--border-strong);

    .frame-title {
      position: absolute;
      top: -1.6em;
      left: 0;
      font-size: 0.8em;
      color: var(--text-faint);
    }
  }

  .divider {
    width: 100%;
    height: 1px;
    background-color: var(--border);
  }

  .fit-quality {
    padding: 0.4em 0;
    color: var(--text-faint);
  }

  .residual {
    align-self: center;
    color: var(--text-faint);
    white-space: nowrap;
    padding-left: 1em;
  }
}
</style>
