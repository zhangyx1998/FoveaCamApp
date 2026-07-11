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
import { computed, ref, watch } from "vue";
import type { Point2d, Size } from "core/Geometry";
import { ROLE, THEME } from "@lib/camera-config";
import { useConfigRef } from "@lib/config";
import { DEFAULT_PREDICTION_RATE_HZ } from "@lib/config-schema";
import {
  anaglyphEyeLabel,
  DEFAULT_ANAGLYPH_STYLE,
  type AnaglyphStyle,
} from "../../../docs/schema/anaglyph";
import { useSession, usePipeFrame } from "@lib/orchestrator/client";
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
import Recording from "@src/record";
import Capture from "@src/capture";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import InlineSelect from "@src/components/InlineSelect.vue";
import Drawer from "@src/components/Drawer.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import SingleSelect, {
  type SingleSelectOption,
} from "@src/inputs/single-select.vue";
import type { TrackerType } from "./tracker-swap";

const session = useSession(disparity, "disparity-scope");
const { state, telemetry } = session;
// Recording context (capture-recorder-everywhere ruling 2): registers this
// window's title-bar RecordButton (AppWindow) + its Cmd/Ctrl-R trigger against
// the session's startRecording/stopRecording — the shared manual-control facade,
// reused not forked. Per-window singleton; disposed on unmount by the facade.
new Recording(session, "disparity-scope");
// Capture context (capture-recorder-everywhere ruling 3): registers this
// window's camera icon (AppWindow) which toggles the shared CapturePreview
// window. Capture DRIVING (the shot trigger) lives in that preview window's
// in-window button — this app needs no bespoke capture UI. Per-window singleton;
// disposed on unmount by the facade.
new Capture(session, "disparity-scope");

// Baseline is RESOLVED SERVER-SIDE now (Ruling A, per-triplet-settings wave):
// the session reads the leased triple's `baseline_mm` (falling back to the
// legacy app-level value, else 200) at activate and pushes it into
// `state.baseline`. The renderer no longer seeds it from app config.

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
// Center view is ONE pipe-backed StreamView over a computed pipe id (composite-
// node-and-center-select-fix §D): every option is a pipe now —
//   sliced    → the scope-tile slice pipe (live-steered server-side),
//   disparity → the `stereo/composite` brick's pipe (mode = difference),
//   anaglyph  → the SAME `stereo/composite` pipe (session retunes mode = anaglyph),
//   sgbm      → the stereo brick's heatmap pipe.
// `usePipeFrame` binds ONLY the selected view's pipe — the C-21 consumer gate
// parks the unwatched producer chain (no subscriber → no compute, stereo-
// disparity-and-heatmap-nodes ruling 2). disparity↔anaglyph flips retune the
// SAME connected composite pipe server-side (no reconnect churn). (The guide
// strip + per-side match heatmaps moved to the module's Debugger.vue sub-window
// — disparity-debugger-window.md.)
const centerFrame = usePipeFrame(() => {
  const c = state.serials?.C;
  if (!c) return null;
  switch (state.view) {
    case "sliced":
      return nodeId.slice(c, "scope-tile");
    case "disparity":
    case "anaglyph":
      return nodeId.stereo("composite");
    case "sgbm":
      return nodeId.heatmap(nodeId.stereo("scope"), "view");
    default:
      return null;
  }
});

// The configured anaglyph style (app config `anaglyph_style`) — drives the
// "Anaglyph" option label so it names the ACTUAL left/right colors. Live: a
// Settings change flows through the shared config doc into this ref. Non-
// blocking (this setup is synchronous) with the RC default until it resolves.
const anaglyphStyle = ref<AnaglyphStyle>(DEFAULT_ANAGLYPH_STYLE);
void useConfigRef("anaglyph_style").then((r) => {
  anaglyphStyle.value = r.value ?? DEFAULT_ANAGLYPH_STYLE;
  watch(r, (v) => (anaglyphStyle.value = v ?? DEFAULT_ANAGLYPH_STYLE));
});

// GLOBAL prediction rate (Hz) — the native IMM brick's feed-forward emit rate
// (prediction-compose-node.md ruling 2). Binds the SAME `prediction_rate_hz`
// config key the Settings → Global config field edits, so this drawer slider
// live-applies through the shared config doc (the disparity-scope session
// subscribes + calls `imm.setParams({ rateHz })`). Non-blocking (synchronous
// setup) with the shared default until the ref resolves; writes clamp 60..1000.
// The default is the SINGLE `@lib/config-schema` constant the Settings field and
// the orchestrator prediction-rate reader both use (was inlined `600` here).
const PREDICTION_RATE_DEFAULT = DEFAULT_PREDICTION_RATE_HZ;
const predictionRateLocal = ref<number>(PREDICTION_RATE_DEFAULT);
let predictionRateCfg: { value: number | undefined } | null = null;
void useConfigRef("prediction_rate_hz").then((r) => {
  predictionRateLocal.value = r.value ?? PREDICTION_RATE_DEFAULT;
  predictionRateCfg = r;
  watch(r, (v) => (predictionRateLocal.value = v ?? PREDICTION_RATE_DEFAULT));
});
const prediction_rate = computed<number>({
  get: () => predictionRateLocal.value,
  set: (v) => {
    const clamped = Math.min(1000, Math.max(60, Math.round(v)));
    predictionRateLocal.value = clamped;
    if (predictionRateCfg) predictionRateCfg.value = clamped;
  },
});

// Center-view select options (one list, rendered into whichever branch's
// title slot is live). The anaglyph label follows the configured style (e.g.
// "Anaglyph (Blue = Left, Red = Right)" under BR).
const VIEW_OPTIONS = computed(
  () =>
    [
      { value: "sliced", label: "Wide Angle Sliced" },
      { value: "disparity", label: "Disparity (Left v.s. Right)" },
      { value: "anaglyph", label: `Anaglyph (${anaglyphEyeLabel(anaglyphStyle.value)})` },
      { value: "sgbm", label: "SGBM Disparity" },
    ] as const,
);

// Object-tracker engine choices for the drawer SingleSelect — the drop-in
// replacement nodes (user request 2026-07-11). Bound to `state.tracker_type`;
// the session hot-swaps the tracker on the fly (tracker-swap.ts). The session
// pins this back on a degraded swap, so the control always shows the ACTIVE
// engine.
const TRACKER_OPTIONS: readonly SingleSelectOption<TrackerType>[] = [
  {
    value: "hybrid",
    label: "Hybrid (NCC + re-detect)",
    hint: "Locks mono needles / low-texture; re-acquires after occlusion.",
  },
  {
    value: "kcf",
    label: "KCF (GRAY)",
    hint: "Classic correlation filter; fast, but silent-forever once lost.",
  },
];

const drawer_height = ref(0);
const stroke = computed(() => Math.max(telemetry.size.width, telemetry.size.height, 1) * 0.003);

// Per-eye pose markers on the (wide) C view: a fovea camera is magnified by the
// zoom ratio, so one fovea frame projects onto the wide view shrunk by that
// ratio. The rects must therefore be the fovea FOOTPRINT (size / zoom), not the
// full wide-frame size — same crop the sliced center view uses. Routed through
// the RESOLVED `match_zoom` so Auto (zoom 0) frames the measured footprint
// instead of the whole frame (`foveaFootprintOnWide` clamps to ≥ 1 internally).
const foveaFootprint = computed(() =>
  foveaFootprintOnWide(telemetry.size, match_zoom.value),
);

// --- tuning: every write replaces the whole `state.tuning` object (a nested
// mutation like `state.tuning.x = v` would neither reach the server nor
// re-render locally — `state.tuning` is a single customRef, not a deep-
// reactive proxy). See docs/history/refactor/orchestrator.md §7.1 S1a.
function setTuning<K extends keyof Tuning>(key: K, value: Tuning[K]): void {
  state.tuning = { ...state.tuning, [key]: value };
}

const sensitivityScale = logScale(0.01, 1.0);
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
// The per-triple zoom override (>0), or null — the middle resolution tier.
const triple_override = computed(() =>
  telemetry.zoom_override != null && telemetry.zoom_override > 0
    ? telemetry.zoom_override
    : null,
);
// The magnification actually driving the template match, under the RULED order
// (2026-07-09, per-triplet-settings wave), mirroring the session's
// `matchZoom()`: the knob (`state.zoom > 0`) is AUTHORITATIVE; `zoom === 0` is
// "Auto" → the per-triple override, else the calibration-measured value, else 1.
// Keeps the "Template Scale" / footprint readouts honest in every mode.
const match_zoom = computed(() =>
  state.zoom > 0
    ? state.zoom
    : (triple_override.value ?? telemetry.match_magnification ?? 1),
);
// Auto-mode readout for the Zoom-Ratio knob (shown only at zoom 0): surfaces the
// RESOLVED magnification AND its source. A per-triple override reads "Auto N×
// (triple override)"; a measured value reads "Auto N×"; with NEITHER,
// `match_zoom` degenerates to 1 and the readout flags "(no cal)" (an honest
// fallback, not a real measured 1×).
const auto_hint = computed(() => {
  const z = `Auto ${match_zoom.value.toFixed(1)}×`;
  if (triple_override.value !== null) return `${z} (triple override)`;
  return telemetry.match_magnification !== null ? z : `${z} (no cal)`;
});
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
  <!-- --p reserves the drawer's height below the content (same idiom as
       manual-control) so the fixed-position drawer never obscures the tail of
       the scrollable page. -->
  <div
    class="cameras"
    :style="{ '--p': (drawer_height ? drawer_height + 20 : 0) + 'px' }"
  >
    <div class="view">
      <StreamView class="stream" :title="ROLE.L" :payload="frameL" :theme="THEME.L" />
      <PosView :pos="telemetry.volt.L" :color="THEME.L" style="width: 100%" />
    </div>
    <div class="view">
      <!-- Single pipe-backed center view (composite-node-and-center-select-fix
           §D): the computed `centerFrame` picks the pipe per `state.view`; the
           InlineSelect rides the (now-forwarded) #title slot once. -->
      <StreamView class="stream" :payload="centerFrame" :theme="THEME.C">
        <template #title>
          <InlineSelect v-model="state.view">
            <option v-for="o in VIEW_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </InlineSelect>
        </template>
      </StreamView>
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
      <!-- The Debugger sub-window toggle moved to the TITLE BAR (AppWindow's
           catalog-driven bug icon, AppMeta.debugWindow — user 2026-07-11). -->
    </div>
    <div class="view">
      <StreamView class="stream" :title="ROLE.R" :payload="frameR" :theme="THEME.R" />
      <PosView :pos="telemetry.volt.R" :color="THEME.R" style="width: 100%" />
    </div>
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
        <RangeSlider
          v-model="prediction_rate"
          :min="60"
          :max="1000"
          :neutral="PREDICTION_RATE_DEFAULT"
          :step="10"
        >
          <span>Prediction Rate</span>
          <span>{{ prediction_rate }} Hz</span>
        </RangeSlider>
        <h4><span>Display</span></h4>
        <label
          class="entry"
          :title="
            state.zoom > 0
              ? 'Explicit zoom drives both the sliced-view crop and the ' +
                'template-match magnification (ruled authoritative — wins over ' +
                'the per-triple override and the measured value)'
              : triple_override !== null
                ? `Auto — using this triple's stored zoom override ` +
                  `(${triple_override.toFixed(2)}x); set a value here to override it`
                : telemetry.match_magnification !== null
                  ? `Auto — using the calibration-measured magnification ` +
                    `(${telemetry.match_magnification.toFixed(2)}x); set a value to override`
                  : 'Auto — no override or calibrated magnification available (falls back to 1); set a value'
          "
        >
          <span>Zoom Ratio</span>
          <!-- Right-side group (mirrors `.kernel-size`): the Auto hint expands
               into free space to the LEFT of the input, which stays anchored at
               the row edge — toggling zoom 0↔value never reflows a neighbor. -->
          <span class="zoom-value">
            <span
              v-if="state.zoom === 0"
              class="auto-hint"
              :class="{
                uncal: triple_override === null && telemetry.match_magnification === null,
              }"
              >{{ auto_hint }}</span
            >
            <input type="number" min="0" step="0.1" v-model.number="state.zoom" />
          </span>
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
        <!-- A bare <label> with no control was inert + misassociated for a11y
             (UI/UX review 2026-07-11); plain row + aria-label on the select. -->
        <div class="entry">
          <span>Type</span>
        </div>
        <!-- Object-tracker engine — swaps on the fly (drop-in nodes). Binds
             state, so it always shows the ACTIVE engine (the session pins it
             back on a degraded swap). -->
        <SingleSelect
          v-model="state.tracker_type"
          :options="TRACKER_OPTIONS"
          aria-label="Tracker type"
        />
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
          <!-- "lost" = the auto-follow gate hit the lost-latch while the
               toggle stays on (re-enable or drag to re-arm) — a stale "armed"
               here contradicted a "frozen" vergence status. -->
          <span>{{
            telemetry.tracker_bbox
              ? "tracking"
              : state.tracker_enabled
                ? telemetry.tracker_lost
                  ? "lost"
                  : "armed"
                : "off"
          }}</span>
        </div>
      </div>
    </div>
  </Drawer>
</template>

<style scoped lang="scss">
.cameras {
  --p: 0; // drawer-height bottom reserve (bound inline from drawer_height)
  position: relative;
  display: flex;
  justify-content: space-evenly;
  align-items: flex-start;
  flex-wrap: wrap;
  flex-direction: row;
  width: 100%;
  padding: 1em 0 calc(1em + var(--p)) 0;
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

.report {
  user-select: none;
  font-family: var(--font-mono);
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
    color: var(--text);
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
    border-right: 1px solid var(--tint-2);
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
      border: 1px solid var(--tint-4);
      border-radius: 4px;
      background: var(--tint-1);
      color: inherit;
      font: inherit;
      text-transform: none;
      letter-spacing: 0;
      padding: 0.1em 0.6em;
      opacity: 0.8;

      &:hover {
        opacity: 1;
        background: var(--tint-3);
      }

      &:active {
        background: var(--tint-2);
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
      background: var(--tint-1);
      border: 1px solid var(--tint-3);
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

    .zoom-value {
      display: inline-flex;
      align-items: center;
      gap: 0.5ch;
    }

    .auto-hint {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      white-space: nowrap;
      // Degenerate Auto (no calibrated magnification) is flagged, not silent —
      // so a fallback 1× never reads as a genuine measured 1×.
      &.uncal {
        color: var(--warn);
      }
    }
  }
}

.debug {
  margin-top: 1em;
  border: 1px solid var(--tint-4);
  border-radius: 4px;
  padding: 0.5em 1em 1em;
  font-family: var(--font-mono);
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
