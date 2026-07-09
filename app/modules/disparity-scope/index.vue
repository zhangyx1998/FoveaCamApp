<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Auto-vergence, migrated to the orchestrator (docs/history/refactor/orchestrator.md
  §7.1 S1a — the §1 flagship). This module is now a thin client over the
  `disparity-scope` session: the orchestrator leases the calibrated L/C/R
  triple, runs the template-match vergence PID and the actuation loop, and
  streams L/C/R + combined-fovea + template-match previews here. The renderer
  only renders frames, overlays telemetry, and drives tuning/target via
  state/commands — no `core`, camera, or calibration access.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { Point2d, Size } from "core/Geometry";
import { ROLE, THEME } from "@lib/camera-config";
import { useAppConfig } from "@lib/config";
import { useFrames, useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { degrees, clamp } from "@lib/util";
import { logScale } from "@lib/conversion";
import { distanceToVerge } from "@lib/stereo";
import {
  disparity,
  DEFAULT_TUNING,
  VERGE_MIN_DISTANCE_MM,
  SHIFT_LIMIT_DEG,
  VSHIFT_LIMIT_DEG,
  type Gains,
  type Tuning,
} from "./contract";
// Core-free display math (NOT ./vergence — that module runtime-imports
// core/Vision, which the renderer must never pull).
import { foveaFootprintOnWide } from "./display-geometry";
import StreamView from "@src/components/StreamView.vue";
import DiffView from "@src/components/DiffView.vue";
import PosView from "@src/components/PosView.vue";
import InlineSelect from "@src/components/InlineSelect.vue";
import Drawer from "@src/components/Drawer.vue";
import RangeSlider from "@src/inputs/range-slider.vue";

const app_config = await useAppConfig();
const session = useSession(disparity, "disparity-scope");
const { state, telemetry } = session;

onMounted(() => {
  if (app_config.baseline_distance_mm) state.baseline = app_config.baseline_distance_mm;
});

// DIAGNOSTIC frames fanned from the orchestrator — only the two per-side
// correlation heatmaps since the node split (split-disparity-nodes): every
// other view is a pipe or a renderer composite.
const { match_left: frameMatchLeft, match_right: frameMatchRight } = useFrames(
  session,
  ["match_left", "match_right"],
);
// View re-plumb (pid-nodes-and-view-replumb.md §Renderer): the L/C/R main views
// source their per-camera `undistort` pipes DIRECTLY via `usePipeFrame` (off the
// JS view-tap loop AND independent of the scope kernel), so a busy kernel can no
// longer cap their fps. Serials come from the same published lease state the
// raw-C view already read. C binds `undistort` too (was `convert`): the overlays
// on that view (target dot, per-eye pose rects, tracker bbox, match rects) are
// now in UNDISTORTED wide pixels, so the frame must share that space to align.
const frameL = usePipeFrame(() =>
  state.serials?.L ? nodeId.undistort(state.serials.L) : null,
);
const frameC = usePipeFrame(() =>
  state.serials?.C ? nodeId.undistort(state.serials.C) : null,
);
const frameR = usePipeFrame(() =>
  state.serials?.R ? nodeId.undistort(state.serials.R) : null,
);
// Split-disparity-nodes views: the sliced center view IS the session's
// scope-tile slice pipe; the guide strip IS the scope-strip slice pipe (both
// live-steered server-side, rendered here at pipe rate); the disparity and
// anaglyph views are renderer canvas composites (DiffView modes) of the two
// pre-warped fovea pipes above; the SGBM view IS the stereo brick's heatmap
// pipe. Pipe-backed center views bind their pipe ONLY while selected — the
// C-21 consumer gate then parks the unwatched producer chain (no subscriber
// → no compute, stereo-disparity-and-heatmap-nodes ruling 2: deselecting
// SGBM stops the whole heatmap→stereo chain).
const frameTile = usePipeFrame(() =>
  state.view === "sliced" && state.serials?.C
    ? nodeId.slice(state.serials.C, "scope-tile")
    : null,
);
const frameSgbm = usePipeFrame(() =>
  state.view === "sgbm" && state.serials?.C
    ? nodeId.heatmap(nodeId.stereo("scope"), "view")
    : null,
);
const frameStrip = usePipeFrame(() =>
  state.serials?.C ? nodeId.slice(state.serials.C, "scope-strip") : null,
);

// Center-view select options (one list, rendered into whichever branch's
// title slot is live).
const VIEW_OPTIONS = [
  { value: "sliced", label: "Wide Angle Sliced" },
  { value: "disparity", label: "Disparity (Left v.s. Right)" },
  { value: "anaglyph", label: "Anaglyph (Red = Left, Cyan = Right)" },
  { value: "sgbm", label: "SGBM Disparity" },
] as const;

const drawer_height = ref(0);
const stroke = computed(() => Math.max(telemetry.size.width, telemetry.size.height, 1) * 0.003);

// Per-eye pose markers on the (wide) C view: a fovea camera is magnified by the
// app-config zoom ratio, so one fovea frame projects onto the wide view shrunk
// by that ratio. The rects must therefore be the fovea FOOTPRINT (size / zoom),
// not the full wide-frame size — same crop the sliced center view uses.
const foveaFootprint = computed(() =>
  foveaFootprintOnWide(telemetry.size, state.zoom),
);

// --- tuning: every write replaces the whole `state.tuning` object (a nested
// mutation like `state.tuning.x = v` would neither reach the server nor
// re-render locally — `state.tuning` is a single customRef, not a deep-
// reactive proxy). See docs/history/refactor/orchestrator.md §7.1 S1a.
function setTuning<K extends keyof Tuning>(key: K, value: Tuning[K]): void {
  state.tuning = { ...state.tuning, [key]: value };
}

const sensitivityScale = logScale(0.1, 10.0);
const sensitivity_ratio = computed<number>({
  get: () => sensitivityScale.toRatio(state.tuning.sensitivity),
  set: (r) => setTuning("sensitivity", sensitivityScale.fromRatio(r)),
});
const timeoutScale = logScale(100, 10000, { infinityAt: 0, round: true });
const timeout_ratio = computed<number>({
  get: () => timeoutScale.toRatio(state.tuning.timeout),
  set: (r) => setTuning("timeout", timeoutScale.fromRatio(r)),
});
const timeout_ms = computed(() => (state.tuning.timeout > 0 ? state.tuning.timeout : Infinity));
const scale_ratio = computed<number>({
  get: () => state.tuning.scale,
  set: (v) => setTuning("scale", v),
});
// The magnification actually driving the template match: the calibration-
// measured fovea↔wide ratio when the session reports one, else the nominal
// zoom knob (the session/kernel apply the exact same fallback) — keeps the
// "Template Scale" readout honest now that the knob no longer influences the
// match on calibrated rigs.
const match_zoom = computed(
  () => telemetry.match_magnification ?? Math.max(1, state.zoom),
);
const min_score = computed<number>({
  get: () => state.tuning.min_score,
  set: (v) => setTuning("min_score", v),
});
const expand_x = computed<number>({
  get: () => state.tuning.expand_x,
  set: (v) => setTuning("expand_x", v),
});
const expand_y = computed<number>({
  get: () => state.tuning.expand_y,
  set: (v) => setTuning("expand_y", v),
});
function resetAllParams(): void {
  state.tuning = {
    ...state.tuning,
    sensitivity: DEFAULT_TUNING.sensitivity,
    scale: DEFAULT_TUNING.scale,
    min_score: DEFAULT_TUNING.min_score,
    expand_x: DEFAULT_TUNING.expand_x,
    expand_y: DEFAULT_TUNING.expand_y,
    timeout: DEFAULT_TUNING.timeout,
  };
}

// --- per-DOF gain groups (Pan / Depth / Vertical) ---------------------------
type GainKey = "pan" | "depth" | "v_shift";
function gainRef(key: GainKey, idx: 0 | 1 | 2) {
  return computed<number>({
    get: () => state.tuning[key][idx],
    set: (v) => {
      const next = [...state.tuning[key]] as Gains;
      next[idx] = v;
      setTuning(key, next);
    },
  });
}
function resetGain(key: GainKey): void {
  setTuning(key, [...DEFAULT_TUNING[key]] as Gains);
}
type GainGroup = {
  key: GainKey;
  title: string;
  range: [number, number];
  step: number;
  terms: [ReturnType<typeof gainRef>, ReturnType<typeof gainRef>, ReturnType<typeof gainRef>];
};
const gainGroups: GainGroup[] = [
  { key: "pan", title: "Pan PID", range: [0, 1], step: 0.01, terms: [gainRef("pan", 0), gainRef("pan", 1), gainRef("pan", 2)] },
  { key: "depth", title: "Depth PID", range: [0, 10], step: 0.02, terms: [gainRef("depth", 0), gainRef("depth", 1), gainRef("depth", 2)] },
  { key: "v_shift", title: "Vertical PID", range: [0, 1], step: 0.01, terms: [gainRef("v_shift", 0), gainRef("v_shift", 1), gainRef("v_shift", 2)] },
];

// --- vergence PID debug/manual-nudge sliders --------------------------------
type Dof = "verge" | "panX" | "panY" | "v_shift";
function radians(deg: number) {
  return (deg * Math.PI) / 180;
}
const shiftLimit = radians(SHIFT_LIMIT_DEG);
const vShiftLimit = radians(VSHIFT_LIMIT_DEG);
const vergeLimits = computed<[number, number]>(() => [
  0,
  distanceToVerge(VERGE_MIN_DISTANCE_MM, state.baseline),
]);
function pidRef(dof: Dof) {
  return computed<number>({
    get: () => telemetry.pids[dof],
    set: (v) => session.call("setPid", { dof, value: v }),
  });
}
const pidVerge = pidRef("verge");
const pidPanX = pidRef("panX");
const pidPanY = pidRef("panY");
const pidVshift = pidRef("v_shift");
const resetVergence = () => session.call("reset_vergence", undefined);

// Same whole-object-replace requirement as `tuning` — `state.kernel.w = v`
// would neither reach the server nor re-render locally.
const kernel_w = computed<number>({
  get: () => state.kernel.w,
  set: (v) => (state.kernel = { ...state.kernel, w: v }),
});
const kernel_h = computed<number>({
  get: () => state.kernel.h,
  set: (v) => (state.kernel = { ...state.kernel, h: v }),
});

// --- pointer: down/move/up phases synthesized from StreamView's mouse event
// (a plain `(Point & Size & {buttons}) | null` stream, not phase-tagged) --
let wasDown = false;
let lastP: Point2d = { x: 0, y: 0 };
function onCursor(c: (Point2d & Size & { buttons: number }) | null): void {
  const down = c !== null && (c.buttons & 1) !== 0;
  if (c) lastP = { x: c.x, y: c.y };
  if (down && !wasDown) {
    session.call("pointer", { p: lastP, buttons: c!.buttons, phase: "down" });
  } else if (down && wasDown) {
    session.call("pointer", { p: lastP, buttons: c!.buttons, phase: "move" });
  } else if (!down && wasDown) {
    session.call("pointer", { p: lastP, buttons: 0, phase: "up" });
  }
  wasDown = down;
}
</script>

<template>
  <div class="cameras">
    <div class="view">
      <StreamView class="stream" :title="ROLE.L" :payload="frameL" :theme="THEME.L" />
      <PosView :pos="telemetry.volt.L" :color="THEME.L" style="width: 100%" />
    </div>
    <div class="view">
      <StreamView v-if="state.view === 'sliced'" class="stream" :payload="frameTile" :theme="THEME.C">
        <template #title>
          <InlineSelect v-model="state.view">
            <option v-for="o in VIEW_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </InlineSelect>
        </template>
      </StreamView>
      <StreamView v-else-if="state.view === 'sgbm'" class="stream" :payload="frameSgbm" :theme="THEME.C">
        <template #title>
          <InlineSelect v-model="state.view">
            <option v-for="o in VIEW_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </InlineSelect>
        </template>
      </StreamView>
      <DiffView
        v-else
        class="stream"
        :a="frameL"
        :b="frameR"
        :mode="state.view === 'anaglyph' ? 'anaglyph' : 'difference'"
        :theme="THEME.C"
      >
        <template #title>
          <InlineSelect v-model="state.view">
            <option v-for="o in VIEW_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </InlineSelect>
        </template>
      </DiffView>
      <StreamView class="stream" :title="ROLE.C" :payload="frameC" :theme="THEME.C" @mouse="onCursor">
        <!-- Target center. -->
        <circle :cx="state.target.x" :cy="state.target.y" :r="stroke * 3" :fill="THEME.C" />
        <!-- Per-eye projected pose (fovea footprint = wide size / zoom). -->
        <rect
          :x="telemetry.L_PX.x - foveaFootprint.width / 2"
          :y="telemetry.L_PX.y - foveaFootprint.height / 2"
          :width="foveaFootprint.width"
          :height="foveaFootprint.height"
          :stroke="THEME.L"
          fill="none"
          :stroke-width="stroke"
        />
        <rect
          :x="telemetry.R_PX.x - foveaFootprint.width / 2"
          :y="telemetry.R_PX.y - foveaFootprint.height / 2"
          :width="foveaFootprint.width"
          :height="foveaFootprint.height"
          :stroke="THEME.R"
          fill="none"
          :stroke-width="stroke"
        />
        <!-- Tracker bounding box. -->
        <rect
          v-if="telemetry.tracker_bbox"
          :x="telemetry.tracker_bbox.x"
          :y="telemetry.tracker_bbox.y"
          :width="telemetry.tracker_bbox.width"
          :height="telemetry.tracker_bbox.height"
          stroke="#0f0"
          :stroke-width="stroke"
          fill="none"
        />
      </StreamView>
      <div class="report">
        Vergence
        <span class="value">{{ degrees(telemetry.vergence).toFixed(2) }}</span>&deg; | Depth
        <span class="value">{{
          telemetry.realized_distance === Infinity ? "&#x221E;" : telemetry.realized_distance.toFixed(4)
        }}</span>m
        | <span class="value">{{ telemetry.status }}</span>
        <!-- §3.5: drags ride the TRACKER override (both eyes parallel on the
             cursor ray, vergence at infinity — direct-follow ruling
             2026-07-08) — the badge mirrors the flag the tracker propagates
             downstream, NOT the PID slot (that slot is programmatic-only
             now, via the pidOverride command). -->
        <span
          v-if="telemetry.overridden"
          class="value override"
          title="Target pinned by pointer drag (tracker override; both eyes follow the cursor ray in parallel, vergence at infinity)"
          >override</span
        >
      </div>
    </div>
    <div class="view">
      <StreamView class="stream" :title="ROLE.R" :payload="frameR" :theme="THEME.R" />
      <PosView :pos="telemetry.volt.R" :color="THEME.R" style="width: 100%" />
    </div>
  </div>

  <div
    class="divergence"
    :style="{ paddingBottom: (drawer_height ? drawer_height + 20 : 0) + 'px' }"
  >
    <StreamView class="wide" title="Template Match Guide Strip" :payload="frameStrip">
      <template v-if="frameStrip">
        <rect
          v-if="telemetry.match_center"
          v-bind="{ x: telemetry.match_center.rect.x, y: telemetry.match_center.rect.y, width: telemetry.match_center.rect.width, height: telemetry.match_center.rect.height }"
          :fill="THEME.C"
          opacity="0.2"
        />
        <rect
          v-if="telemetry.match_left"
          v-bind="{ x: telemetry.match_left.rect.x - 2, y: telemetry.match_left.rect.y - 2, width: telemetry.match_left.rect.width + 4, height: telemetry.match_left.rect.height + 4 }"
          fill="none"
          :stroke="THEME.L"
          stroke-width="2"
          opacity="0.4"
        />
        <rect
          v-if="telemetry.match_right"
          v-bind="{ x: telemetry.match_right.rect.x - 2, y: telemetry.match_right.rect.y - 2, width: telemetry.match_right.rect.width + 4, height: telemetry.match_right.rect.height + 4 }"
          fill="none"
          :stroke="THEME.R"
          stroke-width="2"
          opacity="0.4"
        />
      </template>
    </StreamView>
    <StreamView
      class="wide"
      :title="`Left Match (Red = Match, Blue = Mismatch)`"
      :payload="frameMatchLeft.payload.value" :source="frameMatchLeft.source"
    />
    <StreamView
      class="wide"
      :title="`Right Match (Red = Match, Blue = Mismatch)`"
      :payload="frameMatchRight.payload.value" :source="frameMatchRight.source"
    />
  </div>

  <Drawer v-model="drawer_height">
    <div class="drawer-columns">
      <!-- Column 1: Global Parameters -->
      <div class="options">
        <h4>
          <span>Parameters</span>
          <button class="reset" title="Reset to defaults" @click="resetAllParams">reset</button>
        </h4>
        <RangeSlider
          v-model="sensitivity_ratio"
          :min="0"
          :max="1"
          :neutral="sensitivityScale.toRatio(DEFAULT_TUNING.sensitivity)"
          :step="0.001"
        >
          <span>Sensitivity</span>
          <span>{{ state.tuning.sensitivity.toFixed(3) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="scale_ratio"
          :min="0"
          :max="1"
          :neutral="DEFAULT_TUNING.scale"
          :step="0.01"
        >
          <span>Template Scale</span>
          <span>{{ (1 + (match_zoom - 1) * clamp(scale_ratio, [0, 1])).toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider v-model="min_score" :min="0" :max="1" :neutral="DEFAULT_TUNING.min_score" :step="0.01">
          <span>Min Match Score</span>
          <span>{{ min_score.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="timeout_ratio"
          :min="0"
          :max="1"
          :neutral="timeoutScale.toRatio(DEFAULT_TUNING.timeout)"
          :step="0.01"
        >
          <span>Timeout</span>
          <span>
            <template v-if="timeout_ms !== Infinity">{{ timeout_ms }} ms</template>
            <template v-else> &#x221E; </template>
          </span>
        </RangeSlider>
        <RangeSlider v-model="expand_x" :min="1.0" :max="4.0" :neutral="DEFAULT_TUNING.expand_x" :step="0.1">
          <span>X Expansion</span>
          <span>{{ (expand_x * 100).toFixed(1) }}%</span>
        </RangeSlider>
        <RangeSlider v-model="expand_y" :min="1.0" :max="4.0" :neutral="DEFAULT_TUNING.expand_y" :step="0.1">
          <span>Y Expansion</span>
          <span>{{ (expand_y * 100).toFixed(1) }}%</span>
        </RangeSlider>
        <h4><span>Display</span></h4>
        <label
          class="entry"
          :title="
            telemetry.match_magnification !== null
              ? `Sliced-view crop only — template match uses the calibrated ` +
                `magnification (${telemetry.match_magnification.toFixed(2)}x)`
              : 'Sliced-view crop + template-match magnification (no calibrated value)'
          "
        >
          <span>Zoom Ratio</span>
          <input type="number" v-model.number="state.zoom" />
        </label>
      </div>
      <!-- Columns 2-4: per-DOF gain PIDs (Pan / Depth / Vertical) -->
      <div class="options" v-for="g in gainGroups" :key="g.key">
        <h4>
          <span>{{ g.title }}</span>
          <button class="reset" title="Reset to defaults" @click="resetGain(g.key)">reset</button>
        </h4>
        <RangeSlider
          v-for="(term, i) in g.terms"
          :key="i"
          :model-value="term.value"
          @update:model-value="term.value = $event"
          :min="g.range[0]"
          :max="g.range[1]"
          :neutral="DEFAULT_TUNING[g.key][i]"
          :step="g.step"
        >
          <span>{{ ["Kp", "Ki", "Kd"][i] }}</span>
          <span>{{ term.value.toFixed(2) }}</span>
        </RangeSlider>
      </div>
      <!-- Column 5: Vergence Angles -->
      <div class="options">
        <h4>
          <span>Vergence Angles</span>
          <button class="reset" title="Reset to defaults" @click="resetVergence">reset</button>
        </h4>
        <RangeSlider v-model="pidVerge" :min="vergeLimits[0]" :max="vergeLimits[1]" :neutral="0" :step="0.01">
          <span>Verge</span>
          <span>{{ degrees(pidVerge).toFixed(2) }}&deg;</span>
        </RangeSlider>
        <RangeSlider v-model="pidPanX" :min="-shiftLimit" :max="shiftLimit" :neutral="0" :step="0.01">
          <span>Pan X</span>
          <span>{{ degrees(pidPanX).toFixed(2) }}&deg;</span>
        </RangeSlider>
        <RangeSlider v-model="pidPanY" :min="-shiftLimit" :max="shiftLimit" :neutral="0" :step="0.01">
          <span>Pan Y</span>
          <span>{{ degrees(pidPanY).toFixed(2) }}&deg;</span>
        </RangeSlider>
        <RangeSlider v-model="pidVshift" :min="-vShiftLimit" :max="vShiftLimit" :neutral="0" :step="0.01">
          <span>V-Shift</span>
          <span>{{ degrees(pidVshift).toFixed(2) }}&deg;</span>
        </RangeSlider>
        <fieldset class="debug">
          <legend>PID Debug</legend>
          <div><span>Status</span><span>{{ telemetry.status }}</span></div>
          <div>
            <span>Pan&nbsp;X&nbsp;/&nbsp;Y</span>
            <span>{{ degrees(pidPanX).toFixed(3) }}&deg; / {{ degrees(pidPanY).toFixed(3) }}&deg;</span>
          </div>
          <div><span>Verge</span><span>{{ degrees(pidVerge).toFixed(4) }}</span></div>
          <div>
            <span>Distance (cmd)</span>
            <span>
              <template v-if="telemetry.commanded_distance !== Infinity">
                {{ (telemetry.commanded_distance / 1000).toFixed(3) }} m
              </template>
              <template v-else> &#x221E; </template>
            </span>
          </div>
          <div><span>V-Shift</span><span>{{ degrees(pidVshift).toFixed(3) }}&deg;</span></div>
          <div><span>Actuate</span><span>{{ telemetry.perf.actuateMs.mean.toFixed(2) }} ms</span></div>
        </fieldset>
      </div>
      <!-- Column 6: Wide-angle Tracker -->
      <div class="options">
        <h4>
          <span>Tracker</span>
          <button
            class="reset toggle"
            :class="{ active: state.tracker_enabled }"
            :title="state.tracker_enabled ? 'Disable tracker' : 'Enable tracker'"
            @click="state.tracker_enabled = !state.tracker_enabled"
          >
            {{ state.tracker_enabled ? "on" : "off" }}
          </button>
        </h4>
        <label class="entry">
          <span>Kernel</span>
          <span class="kernel-size">
            <input type="number" v-model.number="kernel_w" min="8" />
            <span>&times;</span>
            <input type="number" v-model.number="kernel_h" min="8" />
          </span>
        </label>
        <div class="entry">
          <span>Status</span>
          <span>{{ telemetry.tracker_bbox ? "tracking" : state.tracker_enabled ? "armed" : "off" }}</span>
        </div>
      </div>
    </div>
  </Drawer>
</template>

<style scoped lang="scss">
.cameras {
  position: relative;
  display: flex;
  justify-content: space-evenly;
  align-items: flex-start;
  flex-wrap: wrap;
  flex-direction: row;
  width: 100%;
  padding: 1em 0;
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

.divergence {
  width: 95vw;
  margin: 2em auto;
  display: flex;
  position: relative;
  flex-direction: column;
  gap: 1em;

  .wide {
    width: 100%;
  }
}

.report {
  user-select: none;
  font-family: monospace;
  font-size: 1.4em;
  font-weight: 500;
  padding: 1em 0;
  .value {
    display: inline-block;
    text-align: right;
    font-weight: 600;
    min-width: 6ch;
  }
  .override {
    min-width: 0;
    padding: 0 0.5ch;
    border-radius: 4px;
    background: #fd05;
    color: #fff;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
}

.drawer-columns {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;

  & > .options {
    flex: 1;
    border-right: 1px solid #fff2;
    &:last-child {
      border-right: none;
    }
  }
}

.options {
  width: 100%;
  height: 100%;
  padding: 1em;
  overflow-x: hidden;
  overflow-y: auto;

  h4 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0.75em 0 0.25em;
    font-weight: 600;
    opacity: 0.7;
    text-transform: uppercase;
    font-size: 0.8em;
    letter-spacing: 0.02em;

    &:first-child {
      margin-top: 0;
    }

    .reset {
      cursor: pointer;
      border: 1px solid #fff4;
      border-radius: 4px;
      background: #fff1;
      color: inherit;
      font: inherit;
      text-transform: none;
      letter-spacing: 0;
      padding: 0.1em 0.6em;
      opacity: 0.8;

      &:hover {
        opacity: 1;
        background: #fff3;
      }

      &:active {
        background: #fff2;
      }

      &.toggle {
        min-width: 3ch;
        text-align: center;
        text-transform: uppercase;
        font-size: 0.9em;

        &.active {
          border-color: #0f08;
          background: #0f02;
          color: #6f6;
          opacity: 1;

          &:hover {
            background: #0f03;
          }
        }
      }
    }
  }

  .entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1ch;
    margin: 0.35em 0;
    font-size: 0.9em;

    input[type="number"] {
      width: 5ch;
      font: inherit;
      color: inherit;
      background: #fff1;
      border: 1px solid #fff3;
      border-radius: 4px;
      padding: 0.1em 0.4em;
    }

    input[type="checkbox"] {
      margin: 0;
    }

    .kernel-size {
      display: inline-flex;
      align-items: center;
      gap: 0.5ch;

      input[type="number"] {
        width: 6ch;
      }
    }
  }
}

.debug {
  margin-top: 1em;
  border: 1px solid #fff4;
  border-radius: 4px;
  padding: 0.5em 1em 1em;
  font-family: monospace;
  font-size: 0.9em;

  legend {
    padding: 0 0.5ch;
    opacity: 0.7;
  }

  div {
    display: flex;
    justify-content: space-between;
    gap: 1ch;
    padding: 0.15em 0;

    span:first-child {
      opacity: 0.7;
    }
  }
}
</style>
