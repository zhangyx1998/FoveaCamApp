<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Manual-control — a thin client over the `manual-control` session (renders
  frames, overlays telemetry, drives state, steers via commands; no core /
  camera / calibration access). Set-points + the remote-canvas checker overlay
  stay 100% renderer-local. Behavior spec: docs/spec/manual-control.md.
-->
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import type { Point2d, Rect } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { ROLE, THEME } from "@lib/camera-config";
import { useConfigRef } from "@lib/config";
import {
  anaglyphEyeLabel,
  DEFAULT_ANAGLYPH_STYLE,
  type AnaglyphStyle,
} from "../../../docs/schema/anaglyph";
import { useFrames, useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import SingleSelect, {
  type SingleSelectOption,
} from "@src/inputs/single-select.vue";
import { getController } from "@src/components/Controller.vue";
import { isEmpty, radians } from "@lib/util";
import Capture from "@src/capture";
import Recording from "@src/record";
import { manualControl, type VoltPreviewQuery, type VoltPair } from "./contract";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import Drawer from "@src/components/Drawer.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import SetPoints from "@src/set-points";
import SetPointsEditor from "@src/set-points/Editor.vue";
import SetPointsList from "@src/set-points/List.vue";
import Line2D from "@src/components/Line2D.vue";
import { Scale } from "@lib/util/math";
import local from "@lib/local";
import Checker from "@src/graphics/Checker.vue";
import StereoFrameGuide from "@src/graphics/StereoFrameGuide.vue";

const session = useSession(manualControl, "manual-control");
const { state, telemetry } = session;
const controller = computed(getController);

// Each main view binds its undistort pipe DIRECTLY (spec §views): C intrinsic
// (raw fallback uncalibrated), L/R homography.
const { center: frameCenter } = useFrames(session, ["center"]);
const frameC = usePipeFrame(() =>
  state.undistortPipe ?? (state.serials?.C ? nodeId.convert(state.serials.C) : null),
);
const frameL = usePipeFrame(() => (state.serials?.L ? nodeId.undistort(state.serials.L) : null));
const frameR = usePipeFrame(() => (state.serials?.R ? nodeId.undistort(state.serials.R) : null));

// Center TILE (spec §views): `sliced` keeps the magnified `session.frame`
// path; disparity/anaglyph bind the COMPOSITE pipe, sgbm the STEREO heatmap
// (native, SHM-bound). Binding only the selected pipe parks the rest (C-21
// consumer gate) — the session ids these under the "manual" scope.
const centerPipeFrame = usePipeFrame(() => {
  switch (state.view) {
    case "disparity":
    case "anaglyph":
      return nodeId.stereo("manual-composite");
    case "sgbm":
      return nodeId.heatmap(nodeId.stereo("manual"), "view");
    default:
      return null; // sliced → session.frame
  }
});
const centerPayload = computed(() =>
  state.view === "sliced" ? frameCenter.payload.value : centerPipeFrame.value,
);

// Configured anaglyph style — labels the "Anaglyph" option with the actual L/R
// colors; live via the shared config doc, RC default until it resolves.
const anaglyphStyle = ref<AnaglyphStyle>(DEFAULT_ANAGLYPH_STYLE);
void useConfigRef("anaglyph_style").then((r) => {
  anaglyphStyle.value = r.value ?? DEFAULT_ANAGLYPH_STYLE;
  watch(r, (v) => (anaglyphStyle.value = v ?? DEFAULT_ANAGLYPH_STYLE));
});
// Center-view select options; the anaglyph label follows the configured style.
const VIEW_OPTIONS = computed(
  () =>
    [
      { value: "sliced", label: "Wide Angle Sliced" },
      { value: "disparity", label: "Disparity (Left v.s. Right)" },
      { value: "anaglyph", label: `Anaglyph (${anaglyphEyeLabel(anaglyphStyle.value)})` },
      { value: "sgbm", label: "SGBM Disparity" },
    ] as const,
);

const points = new SetPoints(local("manual-control.set-points", ""));
const drawer_height = ref(0);

// Targeting: mouse drag (pixel) vs. a selected set-point (angle). `target_loc`
// is renderer-local memory of the last drag, re-activated when a set-point
// selection clears (spec §targeting — no server-side tracker to fall back to).
const target_loc = shallowRef<Point2d>({ x: 0, y: 0 });
const cursor = shallowRef<(Rect & { buttons: number }) | null>(null);
const is_drag = computed(() => cursor.value !== null);

const setpoint_select = ref<number | null>(null);
const setpoint_hover = ref<number | null>(null);
const setpoint = computed(() => {
  const { output } = points;
  if (!Array.isArray(output)) return null;
  return setpoint_select.value ?? setpoint_hover.value;
});
const setpoint_item = computed(() => {
  const i = setpoint.value;
  if (isEmpty(i)) return null;
  const [x, y, d, s] = Array.isArray(points.output)
    ? points.output[i]
    : [undefined, undefined, undefined, undefined];
  return { x, y, d, s };
});

function interactOverride(flag: boolean = true) {
  if (flag) setpoint_select.value = null;
}

watch(cursor, (c) => {
  if (c) {
    target_loc.value = { x: c.x, y: c.y };
    interactOverride();
    void session.call("steer", { mode: "pixel", value: target_loc.value });
  }
});

// Verge/shift deselect a set-point only if it doesn't already override that axis
// (the global slider shouldn't fight a set-point's own pinned distance/shift).
watch(
  () => state.verge,
  () => interactOverride(!isEmpty(setpoint_item.value?.d)),
);
watch(
  () => state.shift,
  () => interactOverride(!isEmpty(setpoint_item.value?.s)),
);

// Push the resolved target whenever the active set-point changes; reverting
// to the last drag position when the selection clears.
watch(setpoint_item, (item) => {
  if (item) {
    const { x = 0, y = 0, d, s } = item;
    void session.call("steer", {
      mode: "angle",
      value: { x: radians(x), y: radians(y) },
      distance_mm: isEmpty(d) ? undefined : d * 1000,
      shift_deg: isEmpty(s) ? undefined : s,
    });
  } else {
    void session.call("steer", { mode: "pixel", value: target_loc.value });
  }
});

// Batch volt preview for every set-point (the `Line2D` trace) — resolved
// server-side (needs calibration), so async-refreshed, not a computed.
const setpoint_volts = ref<VoltPair[]>([]);
watch(
  () => [points.output, state.verge, state.shift, state.baseline] as const,
  async () => {
    const { output } = points;
    if (!Array.isArray(output)) {
      setpoint_volts.value = [];
      return;
    }
    const queries: VoltPreviewQuery[] = output.map(([x, y, d, s]) => ({
      value: { x: radians(x), y: radians(y) },
      distance_mm: isEmpty(d) ? undefined : d * 1000,
      shift_deg: isEmpty(s) ? undefined : s,
    }));
    setpoint_volts.value = await session.call("previewVolts", queries);
  },
  { deep: true, immediate: true },
);

const distance = computed(() =>
  state.verge <= 0 ? Infinity : state.baseline / Math.pow(state.verge, 2),
);
const plusSign = (v: string) => (v.startsWith("-") ? v : "+" + v);

// --- trigger-sync capture (spec §trigger-sync) ------------------------------
// `state.trigger_sync` is USER INTENT — a plain state binding (the server never
// refuses the write). Engagement is the session's: `telemetry.trigger` is
// non-null exactly while engaged, and `trigger_blocked` names why it waits.
// Segmented control over the boolean, via a tiny computed proxy.
const CAPTURE_OPTIONS: readonly SingleSelectOption<"freerun" | "trigger">[] = [
  {
    value: "freerun",
    label: "Free-run",
    hint: "each camera streams at its configured rate",
  },
  {
    value: "trigger",
    label: "Trigger sync",
    hint: "one pulse exposes both foveas — exposure sets the pace",
    title:
      "Every capture becomes a true stereo pair at a uniform rate, paced by " +
      "the fovea pair's exposure budget. The paired rate is usually lower than " +
      "free-run, and the per-camera Frame Rate setting no longer applies — " +
      "shorten the pair's exposure to raise it.",
  },
];
const captureMode = computed<"freerun" | "trigger">({
  get: () => (state.trigger_sync ? "trigger" : "freerun"),
  set: (v) => (state.trigger_sync = v === "trigger"),
});
// Intent ≠ effect while waiting: the ACTIVE option tints warn; the status line
// stays compact — the blocked DETAIL rides the title-bar tray as a warning.
const capturePending = computed(
  () => state.trigger_sync && telemetry.trigger === null,
);
const captureStatus = computed<{ text: string; tone: string; title?: string }>(
  () => {
    if (!state.trigger_sync) return { text: "free-run", tone: "muted" };
    const t = telemetry.trigger;
    if (t) {
      const title = `${t.frames} frames, ${t.rejects} rejects, ${t.timeouts} timeouts`;
      // hz null = the ≥1 s measurement window hasn't matured yet.
      return t.hz === null
        ? { text: "engaged · measuring…", tone: "", title }
        : {
            text: `≈ ${t.hz.toFixed(1)} Hz · pulse ${t.pulseMs.toFixed(1)} ms`,
            tone: "",
            title,
          };
    }
    const reason = telemetry.trigger_blocked ?? "waiting to engage";
    return { text: "free-run — waiting", tone: "warn", title: reason };
  },
);
const stroke = computed(
  () => Math.max(telemetry.size.width, telemetry.size.height, 1) * 0.003,
);

// --- split fovea (per-eye independent steering; spec §split) ----------------
// A PosView drag pins THAT eye to the dragged volt; release keeps the pin.
function dragEye(side: "l" | "r", p: Pos | null): void {
  if (!p) return; // release: hold the pinned pose (no reunify)
  // Do NOT clear a selected set-point here — that fires the `setpoint_item`
  // watcher's revert `steer`, which reunifies and wipes the pin being set.
  void session.call("splitEye", { side, volt: p });
}
const isSplit = computed(() => telemetry.split.l || telemetry.split.r);
// Wide-view fovea footprint (size / zoom), drawn from the per-eye L_PX/R_PX
// projections so the boxes separate while split (spec §split).
const footprint = computed(() => {
  const z = Math.max(1, state.zoom);
  return { width: telemetry.size.width / z, height: telemetry.size.height / z };
});

// --- capture / recording ----------------------------------------------

const capture = new Capture(session, "manual-control");
const recording = new Recording(session, "manual-control");

// --- capture driving (spec §capture) ----------
// The renderer sequences the raster via per-shot `capture({ tag })`; the capture
// node holds the resources, the preview window pulls them via `getPreview`.
const capturing = ref(false);
let abort = false;

function openPreview(): void {
  window.foveaBridge.openDebugWindow("manual-control", "capture");
}

async function runOneShot(): Promise<void> {
  if (capturing.value) return;
  capturing.value = true;
  try {
    await capture.capture(); // fresh single-shot (unindexed)
    openPreview();
  } finally {
    capturing.value = false;
  }
}

async function runRaster(): Promise<void> {
  // A second click / Escape aborts an in-progress raster.
  if (capturing.value) {
    abort = true;
    return;
  }
  const { output } = points;
  if (!Array.isArray(output) || output.length === 0) return runOneShot();
  capturing.value = true;
  abort = false;
  try {
    for (let i = 0; i < output.length; i++) {
      if (abort) break;
      const [x, y, d, s] = output[i]!;
      await session.call("steer", {
        mode: "angle",
        value: { x: radians(x), y: radians(y) },
        distance_mm: isEmpty(d) ? undefined : d * 1000,
        shift_deg: isEmpty(s) ? undefined : s,
      });
      await new Promise((r) => setTimeout(r, 250)); // let the mirrors settle
      if (abort) break;
      await capture.capture(i); // tag i → accumulate an indexed resource
    }
    if (abort) await capture.discard();
    else openPreview();
  } finally {
    capturing.value = false;
    abort = false;
  }
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && capturing.value) abort = true;
});
</script>

<template>
  <div
    class="cameras"
    :style="{ '--p': (drawer_height ? drawer_height + 20 : 0) + 'px' }"
  >
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.L"
        :payload="frameL"
        :theme="THEME.L"
      />
      <PosView
        :pos="telemetry.volt.L"
        :lim="controller?.dv ?? 200"
        :color="THEME.L"
        style="width: 100%"
        @select="(p) => dragEye('l', p)"
      >
        <Line2D
          style="opacity: 0.5"
          :data="setpoint_volts.map((v) => v.l)"
          :focus-color="THEME.L"
          :focus="setpoint_select"
        />
      </PosView>
      <div class="split-tag" :class="{ on: telemetry.split.l }" :style="{ '--color': THEME.L }">
        independent
      </div>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.C + ' (' + state.view + ')'"
        :payload="centerPayload"
        :theme="THEME.C"
      />
      <StreamView
        class="stream"
        :title="isSplit ? ROLE.C + ' — split (drag to reunify)' : ROLE.C"
        :payload="frameC"
        :theme="THEME.C"
        v-model="cursor"
      >
        <circle
          :cx="telemetry.target.x"
          :cy="telemetry.target.y"
          :r="stroke * 3"
          :fill="THEME.C"
        />
        <!-- Per-eye pose footprints, projected from the ACTUAL commanded volts
             (A2P.C∘V2A). When unified both boxes converge on the target; while
             split they separate. Hidden on uncalibrated rigs (no undistort →
             L_PX/R_PX are {0,0}). -->
        <template v-if="state.undistortPipe">
          <rect
            :x="telemetry.L_PX.x - footprint.width / 2"
            :y="telemetry.L_PX.y - footprint.height / 2"
            :width="footprint.width"
            :height="footprint.height"
            :stroke="THEME.L"
            fill="none"
            :stroke-width="stroke"
          />
          <rect
            :x="telemetry.R_PX.x - footprint.width / 2"
            :y="telemetry.R_PX.y - footprint.height / 2"
            :width="footprint.width"
            :height="footprint.height"
            :stroke="THEME.R"
            fill="none"
            :stroke-width="stroke"
          />
        </template>
        <FrameCursor
          :cursor="{ ...telemetry.target, width: telemetry.size.width, height: telemetry.size.height }"
          :angle="telemetry.target_angle"
          box="dot"
          :color="THEME.C"
        />
      </StreamView>
      <ConfigEntry>
        <label>
          <span>Zoom</span>
          <input v-model.number="state.zoom" style="width: 4ch" />
        </label>
        <span>|</span>
        <label>
          <span>View</span>
          <select v-model="state.view">
            <option v-for="o in VIEW_OPTIONS" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </label>
      </ConfigEntry>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.R"
        :payload="frameR"
        :theme="THEME.R"
      />
      <PosView
        :pos="telemetry.volt.R"
        :lim="controller?.dv ?? 200"
        :color="THEME.R"
        style="width: 100%"
        @select="(p) => dragEye('r', p)"
      >
        <Line2D
          style="opacity: 0.5"
          :data="setpoint_volts.map((v) => v.r)"
          :focus-color="THEME.R"
          :focus="setpoint_select"
        />
      </PosView>
      <div class="split-tag" :class="{ on: telemetry.split.r }" :style="{ '--color': THEME.R }">
        independent
      </div>
    </div>
  </div>
  <Drawer v-model="drawer_height">
    <HorizontalDivision
      :division="0.6"
      class="fill"
      :min-width-left="0.2"
      :min-width-right="0.2"
    >
      <template #left>
        <HorizontalDivision
          :division="0.5"
          class="fill"
          :min-width-left="0.3"
          :min-width-right="0.3"
        >
          <template #left>
            <SetPointsEditor :points="points" />
          </template>
          <template #right>
            <SetPointsList
              :points="points"
              :unit="['°', '°', Scale.millimeters]"
              v-model:select="setpoint_select"
              v-model:hover="setpoint_hover"
            />
          </template>
        </HorizontalDivision>
      </template>
      <template #right>
        <div class="options fill">
          <RangeSlider
            v-model="state.verge"
            :min="1"
            :max="0"
            :neutral="0"
            :step="0.01"
          >
            <span>Verge Distance</span>
            <span>
              <template v-if="distance !== Infinity">
                {{ (distance / 1000).toFixed(4) }}m
              </template>
              <template v-else> &#x221E; </template>
            </span>
          </RangeSlider>
          <RangeSlider
            v-model="state.shift"
            :min="-0.5"
            :max="+0.5"
            :neutral="0"
            :step="0.1"
          >
            <span>Vertical Shift</span>
            <span> {{ plusSign(state.shift.toFixed(4)) }}&deg; </span>
          </RangeSlider>
          <RangeSlider
            v-model="state.cap_stack"
            :min="1"
            :max="200"
            :neutral="1"
            :step="10"
          >
            <span>Capture Stack</span>
            <span>{{ state.cap_stack }}</span>
          </RangeSlider>
          <ConfigEntry>
            <button :disabled="capturing" @click="runOneShot">Capture</button>
            <button
              :disabled="!capturing && (!Array.isArray(points.output) || points.output.length === 0)"
              @click="runRaster"
            >
              {{ capturing ? "Abort" : "Raster Capture" }}
            </button>
          </ConfigEntry>
          <!-- Capture Mode (spec §trigger-sync): intent selector — ALWAYS
               enabled (the session gates engagement). While intent is on but not
               engaged the ACTIVE option tints warn (intent ≠ effect cue) and the
               blocked DETAIL rides the title-bar tray as a warning; the
               always-rendered Status row stays compact (text swaps only). -->
          <div class="capture-mode">
            <span class="label">Capture Mode</span>
            <SingleSelect
              v-model="captureMode"
              :options="CAPTURE_OPTIONS"
              class="capture-select"
              :class="{ pending: capturePending }"
              aria-label="Capture mode"
            />
            <div class="status-row">
              <span>Status</span>
              <span
                class="capture-status"
                :class="captureStatus.tone"
                :title="captureStatus.title"
              >{{ captureStatus.text }}</span>
            </div>
          </div>
          <ConfigEntry>
            <label>
              <span>Remote Display</span>
              <select v-model="state.remote_content">
                <option value="NONE">No Content</option>
                <option value="L+R">L + R</option>
                <option value="checker">Checker</option>
              </select>
            </label>
          </ConfigEntry>
          <template v-if="state.remote_content === 'checker'">
            <RangeSlider
              v-model="state.checker_corners"
              :min="1"
              :max="20"
              :neutral="6"
              :step="1"
            >
              <span>Checker</span>
              <span>{{ state.checker_corners }} Corners</span>
            </RangeSlider>
            <RangeSlider
              v-model="state.checker_size_mm"
              :min="1"
              :max="100"
              :neutral="10"
              :step="1"
            >
              <span>Checker Size</span>
              <span>{{ state.checker_size_mm }} mm</span>
            </RangeSlider>
          </template>
        </div>
      </template>
    </HorizontalDivision>
  </Drawer>
  <RemoteCanvasTeleport>
    <template v-if="state.remote_content === 'L+R'">
      <StereoFrameGuide
        :left-color="THEME.L"
        :right-color="THEME.R"
        :center-color="THEME.C"
      />
    </template>
    <Checker
      v-if="state.remote_content === 'checker'"
      :M="state.checker_corners"
      :invert="true"
      :size="state.checker_size_mm"
    />
  </RemoteCanvasTeleport>
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
  --p: 0;
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

.fill {
  width: 100%;
  height: 100%;
}

// Per-eye "independent" badge under the L/R PosViews. Always occupies its row
// (layout-stable: no shift when it appears) — visible only while that eye is
// split, in the eye's THEME color.
.split-tag {
  height: 1.4em;
  line-height: 1.4em;
  font-size: 0.75em;
  font-family: var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color);
  opacity: 0;
  transition: opacity 0.08s;
  pointer-events: none;
  &.on {
    opacity: 1;
  }
  &::before {
    content: "⟂ ";
  }
}

.options {
  padding: 1em;
  overflow-x: hidden;
  overflow-y: scroll;
  & > * {
    height: 2em;
  }
}

// Capture Mode block (spec §trigger-sync) — mirrors the disparity-scope drawer
// idiom (8979b44): a segmented Free-run/Trigger-sync select that tints warn
// while intent ≠ engaged, plus a compact always-rendered Status row.
.capture-mode {
  height: auto !important; // opt out of the .options 2em row cap
  display: flex;
  flex-direction: column;
  gap: 0.35em;
  margin-top: 0.5em;

  .label {
    font-size: 0.8em;
    font-weight: 600;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .capture-select {
    // Intent on, not engaged — the selected option shows intent ≠ effect
    // (warn outline; the blocked detail rides the title-bar tray).
    &.pending :deep(.option.active) {
      border-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 14%, transparent);
    }
  }

  .status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1ch;
    font-size: 0.9em;

    .capture-status {
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      &.muted {
        color: var(--text-muted);
      }
      &.warn {
        color: var(--warn);
      }
    }
  }
}
</style>
