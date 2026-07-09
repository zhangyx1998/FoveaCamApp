<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Manual-control, migrated to the orchestrator. Thin client over the
  `manual-control` session: the orchestrator leases the calibrated L/C/R
  triple, runs the actuation loop against the shared controller, does the
  capture (stack/wrap/diff at full bit depth, held server-side until saved)
  and recording (raw L/C/R streams to disk) — see `docs/history/refactor/
  orchestrator.md` roadmap items 5/6. The renderer only renders frames,
  overlays telemetry, drives parameters via state, and steers via commands —
  no `core`, camera, or calibration access.

  Set-points (`@src/set-points`) and the remote-canvas checker overlay stay
  100% renderer-local — pure client-side data / drawing, no hardware access.
-->
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import type { Point2d, Rect } from "core/Geometry";
import { ROLE, THEME } from "@lib/camera-config";
import { useFrames, useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
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

// real-2b: every main view sources its undistort pipe DIRECTLY (at pipe rate,
// independent of the kernel). The wide view binds the first-class INTRINSIC
// undistort pipe when advertised (target overlay is in undistorted pixel space —
// its correct backdrop), falling back to raw on uncalibrated rigs. The L/R
// foveae bind their HOMOGRAPHY undistort pipes (mirror-pose-tracked warp — what
// the retired `wrap` toggle used to do in the kernel). Only the derived center
// composite (sliced/diff/depth) still rides session.frame.
const { center: frameCenter } = useFrames(session, ["center"]);
const frameC = usePipeFrame(() =>
  state.undistortPipe ?? (state.serials?.C ? nodeId.convert(state.serials.C) : null),
);
const frameL = usePipeFrame(() => (state.serials?.L ? nodeId.undistort(state.serials.L) : null));
const frameR = usePipeFrame(() => (state.serials?.R ? nodeId.undistort(state.serials.R) : null));

const points = new SetPoints(local("manual-control.set-points", ""));
const drawer_height = ref(0);

// --- targeting: mouse drag (pixel) vs. a selected/hovered set-point (angle).
// `target_loc` is renderer-local memory of "where the last drag left off" —
// this session holds no server-side tracker state to fall back to, so this is
// what re-activates when a set-point selection clears.
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

// Verge/shift only deselect a set-point if it doesn't already override that
// axis itself (matches the original: adjusting the global slider shouldn't
// fight a set-point that's already pinned its own distance/shift).
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
// server-side (needs calibration), so this is async-refreshed rather than a
// synchronous computed.
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
const depth_window = computed(() =>
  state.depthWindowInv <= 0 ? Infinity : 1 / Math.pow(state.depthWindowInv, 2),
);
const plusSign = (v: string) => (v.startsWith("-") ? v : "+" + v);
const stroke = computed(
  () => Math.max(telemetry.size.width, telemetry.size.height, 1) * 0.003,
);

// --- capture / recording ----------------------------------------------

const capture = new Capture(session, "manual-control");
const recording = new Recording(session, "manual-control");

// --- capture driving (capture-recorder-nodes Phase 4, ruling 4) ----------
// The renderer sequences the raster: it owns the set-points + steer, so the
// per-shot `capture({ tag })` command replaces the old server-side setpoints
// sweep. The capture NODE holds the resources; the capture-preview window (a
// passive viewer) pulls them via `getPreview`.
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
      >
        <Line2D
          style="opacity: 0.5"
          :data="setpoint_volts.map((v) => v.l)"
          :focus-color="THEME.L"
          :focus="setpoint_select"
        />
      </PosView>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.C + ' (' + state.view + ')'"
        :payload="frameCenter.payload.value" :source="frameCenter.source"
        :theme="THEME.C"
      />
      <StreamView
        class="stream"
        :title="ROLE.C"
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
            <option value="sliced">Sliced</option>
            <option value="diff">Diff</option>
            <option value="depth">Depth</option>
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
      >
        <Line2D
          style="opacity: 0.5"
          :data="setpoint_volts.map((v) => v.r)"
          :focus-color="THEME.R"
          :focus="setpoint_select"
        />
      </PosView>
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
            v-model="state.depthWindowInv"
            :min="1"
            :max="0"
            :neutral="0"
            :step="0.01"
          >
            <span>Depth Window</span>
            <span>
              <template v-if="depth_window !== Infinity">
                {{ (depth_window / 1000).toFixed(4) }} m
              </template>
              <template v-else> &#x221E; </template>
            </span>
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

.options {
  padding: 1em;
  overflow-x: hidden;
  overflow-y: scroll;
  & > * {
    height: 2em;
  }
}
</style>
