<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Thin per-camera config view. Reads the live property snapshot from the
  manage-cameras session telemetry and routes every edit through a command; the
  orchestrator owns the camera and persists changes. No `core` access here.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import StreamView from "@src/components/StreamView.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import type { Session } from "@lib/orchestrator/client";
import type { CameraView, ManageCamerasContract } from "./contract";

const { serial, session } = defineProps<{
  serial: string;
  session: Session<ManageCamerasContract>;
}>();

const view = computed<CameraView | undefined>(
  () => session.telemetry.views[serial],
);

const framePayload = session.frame(serial);

// Writable binding for a camera property: reads the live snapshot, writes via a
// `set` command (the orchestrator applies + persists it).
function field<K extends keyof CameraView>(key: K) {
  return computed<CameraView[K] | undefined>({
    get: () => view.value?.[key],
    set: (value) => void session.call("set", { serial, key, value }),
  });
}

// Numeric variant for `RangeSlider` (modelValue is a required number).
function numField(key: keyof CameraView) {
  return computed<number>({
    get: () => (view.value?.[key] as number) ?? 0,
    set: (value) => void session.call("set", { serial, key, value }),
  });
}

const role = field("role");
const frame_rate_enable = field("frame_rate_enable");
const frame_rate = numField("frame_rate");
const exposure_auto = field("exposure_auto");
const gain_auto = field("gain_auto");
const gain = numField("gain");
const black_level_auto = field("black_level_auto");
const black_level = numField("black_level");

const autoMode = ["Off", "Once", "Continuous"];
const autoModeText: Record<string, string> = {
  Off: "Manual",
  Once: "Auto (once)",
  Continuous: "Auto (cont.)",
};

// log10(us)
function logExp(us: number) {
  return Math.log10(us);
}
logExp.inverse = (v: number) => Math.pow(10, v);

const log_exposure = computed<number>({
  get: () => logExp(view.value?.exposure ?? 1),
  set: (val) => {
    const us = Math.round(logExp.inverse(val) / 100) * 100;
    void session.call("set", { serial, key: "exposure", value: us });
  },
});

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
    <template v-if="view">
      <fieldset>
        <legend>Role Assignment</legend>
        <select v-model="role">
          <option :value="undefined">[ NONE ]</option>
          <option value="L">Fovea Left</option>
          <option value="C">Wide Angle</option>
          <option value="R">Fovea Right</option>
        </select>
      </fieldset>
      <fieldset v-if="view.pixel_format_options?.length">
        <legend>Pixel Format</legend>
        <select
          :value="view.pixel_format"
          :disabled="formatBusy"
          @change="
            changePixelFormat(($event.target as HTMLSelectElement).value)
          "
        >
          <option
            v-for="fmt in view.pixel_format_options"
            :value="fmt"
            :selected="fmt === view.pixel_format"
          >
            {{ fmt }}
          </option>
        </select>
        <p class="hint">
          Changing format briefly pauses the preview to reconfigure the camera.
          12-bit packed formats (e.g. BayerRG12p) read full sensor depth to cut
          debayer quantization noise.
        </p>
      </fieldset>
      <fieldset v-if="view.frame_rate_available">
        <legend>
          Frame Rate
          <select v-model="frame_rate_enable">
            <option :value="true">Manual</option>
            <option :value="false">Auto</option>
          </select>
        </legend>
        <RangeSlider
          v-model="frame_rate"
          :min="view.frame_rate_range.min"
          :max="view.frame_rate_range.max"
          :disabled="!view.frame_rate_enable"
        >
          <span>Frame Rate</span>
          <span>{{ view.frame_rate.toFixed(2) }} FPS</span>
        </RangeSlider>
      </fieldset>
      <fieldset v-if="view.exposure_auto_available">
        <legend>
          Exposure
          <select v-model="exposure_auto">
            <option v-for="mode in autoMode" :value="mode">
              {{ autoModeText[mode] }}
            </option>
          </select>
        </legend>
        <RangeSlider
          v-model="log_exposure"
          :min="logExp(view.exposure_range.min)"
          :max="logExp(view.exposure_range.max)"
          :step="0.001"
          :disabled="view.exposure_auto !== 'Off'"
        >
          <span>Exposure</span>
          <span>{{ (view.exposure / 1000.0).toFixed(2) }} ms</span>
        </RangeSlider>
      </fieldset>
      <fieldset v-if="view.gain_auto_available">
        <legend>
          Gain
          <select v-model="gain_auto">
            <option v-for="mode in autoMode" :value="mode">
              {{ autoModeText[mode] }}
            </option>
          </select>
        </legend>
        <RangeSlider
          v-model="gain"
          :min="view.gain_range.min"
          :max="view.gain_range.max"
          :step="0.001"
          :disabled="view.gain_auto !== 'Off'"
        >
          <span>Gain</span>
          <span>{{ view.gain.toFixed(2) }} dB</span>
        </RangeSlider>
      </fieldset>
      <fieldset v-if="view.black_level_available">
        <legend>
          Black Level
          <select v-model="black_level_auto">
            <option v-for="mode in autoMode" :value="mode">
              {{ autoModeText[mode] }}
            </option>
          </select>
        </legend>
        <RangeSlider
          v-model="black_level"
          :min="view.black_level_range.min"
          :max="view.black_level_range.max"
          :step="0.001"
          :disabled="view.black_level_auto !== 'Off'"
        >
          <span>Black Level</span>
          <span>{{ view.black_level.toFixed(2) }} dB</span>
        </RangeSlider>
      </fieldset>
      <div>
        <button @click="reset">Reset Config</button>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.view {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 1em;
}

fieldset {
  border-radius: 1em;
  border-width: 1px;
  border-color: #fff8;
  &:focus,
  &:focus-within {
    border-color: #08c;
  }
  legend {
    padding: 0 1ch;
  }
  padding: 0.6em 1ch;
}

select {
  font-family: inherit;
  font-size: inherit;
  outline: 1px solid #666;
  border: none;
  background: none;
  border-radius: 4px;
  padding: 0.2em 1ch;
  color: inherit;
  &:focus {
    outline: 1px solid #08c;
  }
}

.hint {
  margin: 0.5em 0 0;
  font-size: 0.8em;
  opacity: 0.6;
}
</style>
