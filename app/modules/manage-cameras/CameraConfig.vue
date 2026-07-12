<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Thin per-camera config view. Reads the live property snapshot from the
  manage-cameras session telemetry and routes every edit through a command; the
  orchestrator owns the camera and persists changes. No `core` access here.

  Slider writes go through a local echo + rAF throttle (the disparity-scope
  `pidRef` pattern): at most one `set` per animation frame, latest value wins,
  and the knob follows the last written value instead of the ~1 Hz snapshot so
  an in-flight stale readout can't yank it mid-drag.
-->
<script setup lang="ts">
import {
  computed,
  onScopeDispose,
  ref,
  watch,
  type Directive,
  type WritableComputedRef,
} from "vue";
import StreamView from "@src/components/StreamView.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import { CAMERA_CONTROLS } from "@lib/camera-config";
import { bindField, usePipeFrame, type Session } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { CameraView, ManageCamerasContract, Range } from "./contract";

// Readout formatters from the shared control schema — the same source the
// orchestrator snapshot uses, so the displayed value can't drift from the wire.
const controlFmt: Record<string, (v: number) => string> = Object.fromEntries(
  CAMERA_CONTROLS.map((c) => [c.key, c.format]),
);

const { serial, session } = defineProps<{
  serial: string;
  session: Session<ManageCamerasContract>;
}>();

const view = computed<CameraView | undefined>(
  () => session.telemetry.views[serial],
);

// Raw preview off the native `camera:<serial>` pipe.
const framePayload = usePipeFrame(nodeId.convert(serial));

const field = <K extends keyof CameraView>(key: K) =>
  bindField(session, view, key, "set", (key, value) => ({ serial, key, value }));

const send = (key: string, value: number) =>
  void session.call("set", { serial, key, value });

// Echo releases on CONFIRMATION — the readout within EPS (0.5% of the slider
// span, below a visible knob jump) of the write; the hard cap only covers a
// write the camera clamped or quantized past EPS. Cap > one snapshot period,
// so a clean confirm normally lands first.
const ECHO_EPS_SPAN = 0.005;
const ECHO_MAX_MS = 1200;
function echoNum(
  live: () => number,
  span: () => number,
  write: (v: number) => void,
) {
  const echo = ref<number | null>(null);
  let cap: ReturnType<typeof setTimeout> | undefined;
  let pending: number | null = null;
  let scheduled = 0;
  const flush = () => {
    scheduled = 0;
    if (pending === null) return;
    const v = pending;
    pending = null;
    write(v);
  };
  watch(live, (v) => {
    if (echo.value === null) return;
    if (Math.abs(v - echo.value) < ECHO_EPS_SPAN * span()) {
      echo.value = null;
      clearTimeout(cap);
    }
  });
  onScopeDispose(() => {
    clearTimeout(cap);
    cancelAnimationFrame(scheduled);
    flush(); // the final drag value must land even on unmount mid-drag
  });
  return computed<number>({
    get: () => echo.value ?? live(),
    set: (v) => {
      echo.value = v;
      clearTimeout(cap);
      cap = setTimeout(() => (echo.value = null), ECHO_MAX_MS);
      pending = v;
      if (!scheduled) scheduled = requestAnimationFrame(flush);
    },
  });
}

const spanOf = (r?: Range) => (r ? r.max - r.min : 0);
const clampTo = (v: number, r?: Range) =>
  r ? Math.min(Math.max(v, r.min), r.max) : v;
const inRange = (v: number, r?: Range) => !!r && v >= r.min && v <= r.max;

// log10(us)
function logExp(us: number) {
  return Math.log10(us);
}
logExp.inverse = (v: number) => Math.pow(10, v);

type ModeOption = { value: string | boolean | undefined; label: string };
type Control = {
  key: string;
  label: string;
  available: () => boolean;
  mode: { model: WritableComputedRef<any>; options: ModeOption[]; title: string };
  manual: () => boolean;
  slider: WritableComputedRef<number>;
  min: () => number;
  max: () => number;
  step: number;
  detents: () => number[] | undefined;
  readout: () => string;
  /** Units the click-to-type input accepts (= the readout's units). */
  editUnits: string;
  editValue: () => number;
  commit: (value: number) => void;
};

const AUTO_OPTIONS: ModeOption[] = [
  { value: "Off", label: "Manual" },
  { value: "Once", label: "Auto (once)" },
  { value: "Continuous", label: "Auto (cont.)" },
];

const FLICKER_HZ = [50, 60, 100, 120];

const frameRate: Control = {
  key: "frame_rate",
  label: "Frame Rate",
  available: () => !!view.value?.frame_rate_available,
  mode: {
    model: field("frame_rate_enable"),
    options: [
      { value: true, label: "Manual" },
      { value: false, label: "Auto" },
    ],
    title: "Manual: the slider sets the rate; Auto: the camera free-runs",
  },
  manual: () => !!view.value?.frame_rate_enable,
  slider: echoNum(
    () => view.value?.frame_rate ?? 0,
    () => spanOf(view.value?.frame_rate_range),
    (v) => send("frame_rate", v),
  ),
  min: () => view.value?.frame_rate_range.min ?? 0,
  max: () => view.value?.frame_rate_range.max ?? 0,
  step: 1,
  detents: () =>
    FLICKER_HZ.filter((hz) => inRange(hz, view.value?.frame_rate_range)),
  readout: () => controlFmt.frame_rate(view.value?.frame_rate ?? 0),
  editUnits: "FPS",
  editValue: () => view.value?.frame_rate ?? 0,
  commit: (v) => {
    frameRate.slider.value = clampTo(v, view.value?.frame_rate_range);
  },
};

// Anti-flicker detents: exposure = a mains half-period rejects 100/120 Hz
// light flicker. Detents are in the SLIDER's model units — log10(µs) — so
// 1/60 s enters as log10(1e6 / 60). Round decades (1 ms, 10 ms, …) ride along.
const flickerUs = FLICKER_HZ.map((hz) => 1e6 / hz);
function exposureDetents(): number[] {
  const r = view.value?.exposure_range;
  if (!r || r.max <= r.min) return [];
  const us = flickerUs.filter((v) => inRange(v, r));
  for (let k = Math.ceil(logExp(Math.max(r.min, 1))); 10 ** k <= r.max; k++)
    if (10 ** k >= r.min) us.push(10 ** k);
  return [...new Set(us)].map(logExp);
}

const exposure: Control = {
  key: "exposure",
  label: "Exposure",
  available: () => !!view.value?.exposure_auto_available,
  mode: {
    model: field("exposure_auto"),
    options: AUTO_OPTIONS,
    title:
      "Manual: the slider sets exposure; Auto lets the camera meter it (once or continuously)",
  },
  manual: () => view.value?.exposure_auto === "Off",
  // Integer µs (was 100 µs rounding): anti-flicker detents like 1/60 s =
  // 16666.7 µs must land exactly, not at 16700 µs.
  slider: echoNum(
    () => logExp(view.value?.exposure ?? 1),
    () =>
      logExp(view.value?.exposure_range.max ?? 1) -
      logExp(view.value?.exposure_range.min ?? 1),
    (v) => send("exposure", Math.round(logExp.inverse(v))),
  ),
  min: () => logExp(view.value?.exposure_range.min ?? 1),
  max: () => logExp(view.value?.exposure_range.max ?? 1),
  step: 0.001,
  detents: exposureDetents,
  readout: () => controlFmt.exposure(view.value?.exposure ?? 0),
  editUnits: "ms",
  editValue: () => (view.value?.exposure ?? 0) / 1000,
  commit: (ms) => {
    exposure.slider.value = logExp(
      clampTo(ms * 1000, view.value?.exposure_range),
    );
  },
};

function dbControl(
  key: "gain" | "black_level",
  label: string,
  availableKey: "gain_auto_available" | "black_level_available",
): Control {
  const range = () => view.value?.[`${key}_range`];
  const ctl: Control = {
    key,
    label,
    available: () => !!view.value?.[availableKey],
    mode: {
      model: field(`${key}_auto`),
      options: AUTO_OPTIONS,
      title: `Manual: the slider sets ${label.toLowerCase()}; Auto lets the camera set it (once or continuously)`,
    },
    manual: () => view.value?.[`${key}_auto`] === "Off",
    slider: echoNum(
      () => view.value?.[key] ?? 0,
      () => spanOf(range()),
      (v) => send(key, v),
    ),
    min: () => range()?.min ?? 0,
    max: () => range()?.max ?? 0,
    step: 0.001,
    detents: () => undefined,
    readout: () => controlFmt[key](view.value?.[key] ?? 0),
    editUnits: "dB",
    editValue: () => view.value?.[key] ?? 0,
    commit: (v) => {
      ctl.slider.value = clampTo(v, range());
    },
  };
  return ctl;
}

const controls: Control[] = [
  frameRate,
  exposure,
  dbControl("gain", "Gain", "gain_auto_available"),
  dbControl("black_level", "Black Level", "black_level_available"),
];

const role = field("role");

const formatBusy = ref(false);
async function changePixelFormat(format: string) {
  if (formatBusy.value || format === view.value?.pixel_format) return;
  formatBusy.value = true;
  try {
    await session.call("setPixelFormat", { serial, format });
  } finally {
    formatBusy.value = false;
  }
}

function reset() {
  void session.call("reset", { serial });
}

// Click-to-type readout: the input replaces the value span in the same box
// (layout-stable). Enter/blur commit, Escape cancels.
const editing = ref<string | null>(null);
const draft = ref("");
const vFocus: Directive<HTMLInputElement> = {
  mounted: (el) => {
    el.focus();
    el.select();
  },
};
function beginEdit(c: Control) {
  if (!c.manual()) return;
  editing.value = c.key;
  draft.value = String(Number(c.editValue().toFixed(3)));
}
// Keyboard exits (Enter/Esc) hand focus back to the slider root so arrow-key
// flow continues; a blur commit doesn't — the user deliberately left.
function refocusSlider(e?: Event) {
  (e?.target as HTMLElement | null)
    ?.closest<HTMLElement>(".range-slider")
    ?.focus();
}
function commitEdit(c: Control, e?: Event) {
  if (editing.value !== c.key) return;
  editing.value = null;
  const n = Number(draft.value);
  if (draft.value.trim() !== "" && Number.isFinite(n)) c.commit(n);
  refocusSlider(e);
}
function cancelEdit(e?: Event) {
  editing.value = null;
  refocusSlider(e);
}
</script>

<template>
  <div class="view">
    <StreamView
      class="stream"
      :title="view?.description"
      :payload="framePayload"
      width="100%"
      theme="white"
    />
    <div v-if="view" class="options">
      <h4>
        <span>Role</span>
        <select
          v-model="role"
          class="inline"
          title="Tell the stereo and tracking apps which position this camera occupies"
        >
          <option :value="undefined">[ NONE ]</option>
          <option value="L">Fovea Left</option>
          <option value="C">Wide Angle</option>
          <option value="R">Fovea Right</option>
        </select>
      </h4>
      <template v-if="view.pixel_format_options?.length">
        <h4>
          <span>Pixel Format</span>
          <select
            class="inline"
            :value="view.pixel_format"
            :disabled="formatBusy"
            title="Sensor readout format; changing it briefly pauses the preview"
            @change="
              changePixelFormat(($event.target as HTMLSelectElement).value)
            "
          >
            <option
              v-for="fmt in view.pixel_format_options"
              :key="fmt"
              :value="fmt"
            >
              {{ fmt }}
            </option>
          </select>
        </h4>
        <p class="hint">
          Changing format briefly pauses the preview to reconfigure the camera.
          12-bit packed formats (e.g. BayerRG12p) read full sensor depth to cut
          debayer quantization noise.
        </p>
      </template>
      <template v-for="c in controls" :key="c.key">
        <template v-if="c.available()">
          <h4>
            <span>{{ c.label }}</span>
            <select
              v-model="c.mode.model.value"
              class="inline"
              :title="c.mode.title"
              :aria-label="`${c.label} mode`"
            >
              <option
                v-for="o in c.mode.options"
                :key="String(o.value)"
                :value="o.value"
              >
                {{ o.label }}
              </option>
            </select>
          </h4>
          <RangeSlider
            v-model="c.slider.value"
            :min="c.min()"
            :max="c.max()"
            :step="c.step"
            :detents="c.detents()"
            :disabled="!c.manual()"
          >
            <span>{{ c.label }}</span>
            <!-- keydown.stop: arrow keys must edit the TEXT, not bubble to the
                 slider root's handler (which would move the camera value under
                 the caret — review F5). -->
            <input
              v-if="editing === c.key"
              v-focus
              v-model="draft"
              class="value"
              :title="`Exact value in ${c.editUnits}; Enter commits, Esc cancels`"
              @mousedown.stop
              @keydown.stop
              @keydown.enter="commitEdit(c, $event)"
              @keydown.esc="cancelEdit($event)"
              @blur="commitEdit(c)"
            />
            <span
              v-else
              class="value"
              :class="{ editable: c.manual() }"
              :title="c.manual() ? 'Click to type an exact value' : undefined"
              @mousedown.stop
              @click="beginEdit(c)"
            >
              {{ c.readout() }}
            </span>
          </RangeSlider>
        </template>
      </template>
      <button
        class="reset-config"
        title="Reset this camera to auto (run once), clear its role, and erase its saved configuration"
        @click="reset"
      >
        Reset Config
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.view {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 1em;
}

// Drawer-standard column idiom (disparity-scope drawer): h4 header row =
// group name + inline mode select; controls below; spacing over borders.
.options {
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
  }

  select.inline {
    font: inherit;
    text-transform: none;
    letter-spacing: 0;
    color: inherit;
    background: var(--tint-1);
    border: 1px solid var(--tint-4);
    border-radius: 4px;
    padding: 0.1em 0.6em;
    cursor: pointer;

    &:hover {
      background: var(--tint-3);
    }
    &:focus {
      outline: 1px solid var(--accent);
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
}

// Readout / inline editor share one right-aligned box inside the slider slot
// so swapping them never reflows the row.
.value {
  min-width: 11ch;
  box-sizing: border-box;
  text-align: right;
  pointer-events: auto;
}
span.value.editable {
  cursor: text;
}
input.value {
  width: 11ch;
  height: 1.6em;
  font: inherit;
  color: inherit;
  background: var(--tint-1);
  border: 1px solid var(--tint-3);
  border-radius: 4px;
  padding: 0 0.4ch;
}

.reset-config {
  display: block;
  margin: 1.25em 0 0 auto;
  cursor: pointer;
  font: inherit;
  font-size: 0.8em;
  padding: 0.2em 1ch;
  border-radius: 4px;
  color: var(--danger-text);
  border: 1px solid var(--danger-strong);
  background: none;
  opacity: 0.8;

  &:hover {
    opacity: 1;
    background: var(--danger-bg);
  }
  &:active {
    background: var(--danger-bg);
    filter: brightness(1.4);
  }
}

.hint {
  margin: 0.5em 0 0;
  font-size: 0.8em;
  opacity: 0.6;
}
</style>
