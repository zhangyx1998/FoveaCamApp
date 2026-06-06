<script setup lang="ts">
import {
  computed,
  onUnmounted,
  reactive,
  ref,
  shallowRef,
  watch,
  type Ref,
} from "vue";
import { Point2d, Rect } from "core/Geometry";
import { Mat, slice, diff, wrapPerspective } from "core/Vision";
import { Frame } from "core/Aravis";
import {
  getFrameSize,
  ROLE,
  THEME,
  useCalibratedTriple,
  useCoordinateConversions,
} from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import { getController } from "@src/components/Controller.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import abortable from "@lib/abortable";
import { Latest, Zip } from "@lib/util/iter";
import FrameView from "@src/components/FrameView.vue";
import InlineSelect from "@src/components/InlineSelect.vue";
import Drawer from "@src/components/Drawer.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import { deg } from "@lib/util/math";
import { RECT } from "@lib/util/geometry";
import { useAppConfig } from "@lib/config";
import local from "@lib/local";
import { clamp, degrees, radians } from "@lib/util";
import { distanceToVerge, vergeToDistance } from "@lib/stereo";
import { PID } from "@lib/pid";
import { rad2deg } from "@lib/conversion";
import {
  analyzeVergence,
  stepVergence,
  type MatchResult,
  type VergencePIDs,
} from "./vergence";

const view = ref<"disparity" | "sliced">("sliced");
const app_config = await useAppConfig();

// Optimizable per-DOF PID gains (kp / ki / kd), persisted in localStorage so
// tuning is independent of the shared app config. `.reset()` clears the stored
// override and reverts to the default.
const gain = (dof: string, term: string, init: number) =>
  local(`disparity-scope.pid.${dof}.${term}`, init);

const pan_kp = gain("pan", "kp", 0.02);
const pan_ki = gain("pan", "ki", 0.02);
const pan_kd = gain("pan", "kd", 0);
const depth_kp = gain("depth", "kp", 1.0);
const depth_ki = gain("depth", "ki", 0.2);
const depth_kd = gain("depth", "kd", 0.5);
const v_shift_kp = gain("v_shift", "kp", 0.02);
const v_shift_ki = gain("v_shift", "ki", 0.02);
const v_shift_kd = gain("v_shift", "kd", 0);

// Template-match scale, confidence gate, and master responsiveness, persisted
// in localStorage (like the PID gains) so tuning is independent of app config.
const scale_ratio = local("disparity-scope.controls.scale", 0);
const min_score = local("disparity-scope.controls.min_score", 0.1);
// sensitivity = control time step per ms elapsed (absorbs the old
// nominal-fps × ms→s scaling). Larger = faster convergence, less damping.
const sensitivity = local("disparity-scope.controls.sensitivity", 1.0);

const SENSITIVITY_MIN = 0.1;
const SENSITIVITY_MAX = 10.0;
function sensitivityToRatio(val: number) {
  return clamp(
    Math.log(val / SENSITIVITY_MIN) /
      Math.log(SENSITIVITY_MAX / SENSITIVITY_MIN),
    [0, 1],
  );
}
function ratioToSensitivity(r: number) {
  return SENSITIVITY_MIN * Math.pow(SENSITIVITY_MAX / SENSITIVITY_MIN, r);
}
const sensitivity_ratio = computed<number>({
  get: () => sensitivityToRatio(sensitivity.value),
  set: (r) => (sensitivity.value = ratioToSensitivity(r)),
});

// Guide expansion around target tile
const expand_x = local("disparity-scope.controls.expand_x", 3.0);
const expand_y = local("disparity-scope.controls.expand_y", 2.0);

// Auto-vergence convergence timeout. The slider is exponential: the far-right
// end (ratio === 1) maps to "no timeout" (iterate forever); everywhere else
// interpolates [TIMEOUT_MIN_MS, TIMEOUT_MAX_MS] on a log scale.
const TIMEOUT_MIN_MS = 100;
const TIMEOUT_MAX_MS = 10000;
function msToRatio(ms: number) {
  if (!(ms > 0) || ms === Infinity) return 1;
  return clamp(
    Math.log(ms / TIMEOUT_MIN_MS) / Math.log(TIMEOUT_MAX_MS / TIMEOUT_MIN_MS),
    [0, 1],
  );
}
function ratioToMs(r: number) {
  if (r >= 1) return 0; // 0 = no timeout (iterate forever)
  return Math.round(
    TIMEOUT_MIN_MS * Math.pow(TIMEOUT_MAX_MS / TIMEOUT_MIN_MS, r),
  );
}
// timeout_ms_local persists the timeout in localStorage (default 2000ms).
const timeout_ms_local = local("disparity-scope.controls.timeout", 2000);
const timeout_ratio = computed<number>({
  get: () => msToRatio(timeout_ms_local.value),
  set: (r) => (timeout_ms_local.value = ratioToMs(r)),
});
const timeout_ms = computed(() => {
  const v = timeout_ms_local.value;
  return v > 0 ? v : Infinity;
});
const drawer_height = ref(0);
const controller = computed(getController);
const triple = await useCalibratedTriple();
const { L, C, R } = triple;
const { A2V, V2A, P2A, A2P, A2H } = useCoordinateConversions(triple);

const { width, height } = await getFrameSize(C);
const undistort = triple.CI.undistort;
if (!undistort)
  throw new Error("Intrinsic calibration not found for center camera.");

const cursor = shallowRef<(Rect & { buttons: number }) | null>(null);
const target_loc = shallowRef<Point2d>({ x: width / 2, y: height / 2 });
const target_size = computed(() => ({
  width: width / zoom.value,
  height: height / zoom.value,
}));
const target = computed(() =>
  RECT.fromCenter(target_loc.value, target_size.value),
);

const zoom = computed<number>({
  get: () => Math.max(1.0, triple.config.zoom_factor ?? 9.0),
  set: (v) => (triple.config.zoom_factor = v),
});

const scale = computed(
  () => 1 + (zoom.value - 1) * clamp(scale_ratio.value, [0, 1]),
);

const is_drag = computed(
  () => cursor.value !== null && (cursor.value.buttons & 1) !== 0,
);

// Start of the current convergence window. The mirrors auto-verge until
// `timeout_ms` has elapsed since the last mouse release, then freeze.
// Evaluated per-frame inside the loop (not reactive — `performance.now()`).
const window_start = ref(performance.now());
function frozen() {
  const t = timeout_ms.value;
  return t !== Infinity && performance.now() - window_start.value > t;
}

watch(cursor, (c) => {
  if (c && is_drag.value) {
    const { x, y } = c;
    target_loc.value = { x, y };
  }
});

const volt = reactive({
  L: { x: 0, y: 0 },
  R: { x: 0, y: 0 },
});

// Physical saturation limits — a bad estimate can at worst rest at a limit.
const SHIFT_LIMIT = radians(5); // max common-mode ray correction (rad)
const VSHIFT_LIMIT = radians(2); // max vertical shift between foveas (rad)
const VERGE_MIN_DISTANCE_MM = 150; // nearest convergence distance
const DT_MAX_FRAMES = 10; // cap a single step after a stall / un-freeze

// One PID per constrained DOF; the clamped integrator is the command. Both
// fovea poses are reconstructed from these, so they stay symmetric about the
// ray. Gains (ki) track the sliders; limits encode the physical saturation.
const pids: VergencePIDs = {
  panX: new PID({ limits: [-SHIFT_LIMIT, SHIFT_LIMIT] }),
  panY: new PID({ limits: [-SHIFT_LIMIT, SHIFT_LIMIT] }),
  verge: new PID({
    limits: [
      0,
      distanceToVerge(VERGE_MIN_DISTANCE_MM, app_config.baseline_distance_mm),
    ],
  }),
  v_shift: new PID({ limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT] }),
};
// Sync slider gains onto the PID controllers (pan drives both shift axes).
function bindGains(
  kp: Ref<number>,
  ki: Ref<number>,
  kd: Ref<number>,
  targets: PID[],
) {
  watch(
    [kp, ki, kd],
    ([p, i, d]) => targets.forEach((t) => ((t.kp = p), (t.ki = i), (t.kd = d))),
    { immediate: true },
  );
}
bindGains(pan_kp, pan_ki, pan_kd, [pids.panX, pids.panY]);
bindGains(depth_kp, depth_ki, depth_kd, [pids.verge]);
bindGains(v_shift_kp, v_shift_ki, v_shift_kd, [pids.v_shift]);

// Per-group reset: clear the stored values and revert to defaults.
const resetParams = () =>
  [
    sensitivity,
    scale_ratio,
    min_score,
    timeout_ms_local,
    expand_x,
    expand_y,
  ].forEach((r) => r.reset());
const resetPan = () => [pan_kp, pan_ki, pan_kd].forEach((r) => r.reset());
const resetDepth = () =>
  [depth_kp, depth_ki, depth_kd].forEach((r) => r.reset());
const resetVertical = () =>
  [v_shift_kp, v_shift_ki, v_shift_kd].forEach((r) => r.reset());
const resetVergence = () => Object.values(pids).forEach((p) => p.reset());

// Neutral values for the sliders, extracted from the local refs' defaults
// so the UI stays in sync with the source-of-truth default definitions.
const neutrals = {
  sensitivity: sensitivityToRatio(sensitivity.default),
  scale_ratio: scale_ratio.default,
  min_score: min_score.default,
  expand_x: expand_x.default,
  expand_y: expand_y.default,
  pan_kp: pan_kp.default,
  pan_ki: pan_ki.default,
  pan_kd: pan_kd.default,
  depth_kp: depth_kp.default,
  depth_ki: depth_ki.default,
  depth_kd: depth_kd.default,
  v_shift_kp: v_shift_kp.default,
  v_shift_ki: v_shift_ki.default,
  v_shift_kd: v_shift_kd.default,
  timeout: msToRatio(timeout_ms_local.default),
};

// On mouse release: restart the convergence window and reset every controller
// so the foveas re-converge fresh on the new target (no stale integrator wind-up).
watch(is_drag, (dragging, wasDragging) => {
  if (wasDragging && !dragging) {
    window_start.value = performance.now();
    for (const pid of Object.values(pids)) pid.reset();
  }
});

const status = ref<string>("initializing");
const distance = computed(() =>
  vergeToDistance(pids.verge.value, app_config.baseline_distance_mm),
);

const L_PX = computed(() => A2P.C(V2A.L(volt.L)));
const R_PX = computed(() => A2P.C(V2A.R(volt.R)));

const actuate_task = abortable(async (_, onAbort) => {
  const c = controller.value;
  if (!c) return;
  const updated = new Latest<Point2d>();
  onAbort(() => updated.close());
  const handle = watch(target_loc, (t) => updated.push(t), {
    deep: true,
    immediate: true,
  });
  try {
    await c.enable();
    for await (const pos of updated) {
      const [r] = undistort.angular([pos], true);
      const { left, right } = await c.actuate({
        left: A2V.L(r),
        right: A2V.R(r),
      });
      volt.L = left;
      volt.R = right;
    }
  } finally {
    await c.disable();
    handle.stop();
  }
});

const guide = ref<Mat<Uint8Array> | null>(null);

const match_left = shallowRef<MatchResult | null>(null);
const match_right = shallowRef<MatchResult | null>(null);
const match_center = shallowRef<{ rect: Rect } | null>(null);

const divergence = computed(() => V2A.L(volt.L).x - V2A.R(volt.R).x);
const depth = computed(() => {
  const baseline = app_config.baseline_distance_mm / 1000; // meters
  const d = baseline / Math.sin(divergence.value);
  // A negative depth means the gaze lines diverge (no convergence point in
  // front of the cameras) — perceptually infinitely far. Same for absurdly
  // large magnitudes as divergence approaches zero.
  return d > 0 && d < 1e8 ? d.toFixed(4) : "∞";
});

const wrap_enable = ref(true);
const wrap = {
  L(mat: Mat<Uint8Array>) {
    if (!wrap_enable.value) return mat;
    const A = V2A.L(volt.L);
    const H = A2H.L(A);
    return wrapPerspective(mat, H);
  },
  R(mat: Mat<Uint8Array>) {
    if (!wrap_enable.value) return mat;
    const A = V2A.R(volt.R);
    const H = A2H.R(A);
    return wrapPerspective(mat, H);
  },
};

const mat_l = ref<Mat<Uint8Array> | null>(null);
const mat_c = ref<Mat<Uint8Array> | null>(null);
const mat_r = ref<Mat<Uint8Array> | null>(null);

const center_view = computed(() => {
  if (view.value === "sliced") {
    const m = mat_c.value;
    if (!m) return null;
    return slice(m, target.value);
  } else {
    const [l, r] = [mat_l.value, mat_r.value];
    if (!l || !r) return null;
    return diff(l, r, true);
  }
});

const divergence_task = abortable(async (aborted) => {
  const zip = new Zip(L.stream, C.stream, R.stream);
  let l: Frame | null = null,
    c: Frame | null = null,
    r: Frame | null = null;
  // Wall-clock reference for the previous control step (not the previous frame:
  // skipped frames during drag/freeze must not accumulate into the integrator).
  let last_step = performance.now();
  async function update(
    l: Mat<Uint8Array>,
    c: Mat<Uint8Array>,
    r: Mat<Uint8Array>,
  ) {
    const analysis = await analyzeVergence(
      { l, c, r },
      {
        width,
        height,
        zoom: zoom.value,
        scale: scale.value,
        target: target_loc.value,
        expand_x: expand_x.value,
        expand_y: expand_y.value,
      },
    );
    guide.value = analysis.guide;
    match_left.value = analysis.ml;
    match_right.value = analysis.mr;
    match_center.value = analysis.center;
    // Update divergence
    const ctrl = controller.value;
    if (is_drag.value || !ctrl || frozen()) {
      status.value = is_drag.value
        ? "manual"
        : !ctrl
          ? "no controller"
          : "frozen";
      return;
    }
    // Rate-normalized control time step (sensitivity bakes in the ms→step
    // scaling), capped so a stall / un-freeze can't dump a huge catch-up step.
    const now = performance.now();
    const dt = Math.min((now - last_step) * sensitivity.value, DT_MAX_FRAMES);
    last_step = now;
    const result = stepVergence(
      analysis,
      pids,
      { P2A, A2V },
      { baseline: app_config.baseline_distance_mm, minScore: min_score.value },
      dt,
    );
    // Hold position when the match is too weak to trust.
    if (!result) {
      status.value = "holding";
      return;
    }
    status.value = "tracking";
    // Request might be rejected when user is dragging.
    try {
      const { left, right } = await ctrl.actuate({
        left: result.left,
        right: result.right,
      });
      volt.L = { ...left };
      volt.R = { ...right };
    } catch (e) {
      console.warn("Divergence adjustment failed:", e);
    }
  }
  try {
    for (const [_l, _c, _r] of zip) {
      if (aborted()) return;
      if (_l) {
        l?.release();
        l = _l;
      }
      if (_c) {
        c?.release();
        c = _c;
      }
      if (_r) {
        r?.release();
        r = _r;
      }
      if (l && c && r) {
        const [lm, cm, rm] = await Promise.all([
          l.view("BGRA8").then(wrap.L),
          c.view("BGRA8"),
          r.view("BGRA8").then(wrap.R),
        ]);
        mat_l.value = lm;
        mat_c.value = cm;
        mat_r.value = rm;
        l.release();
        c.release();
        r.release();
        l = null;
        c = null;
        r = null;
        await update(lm, cm, rm);
      } else {
        await new Promise(requestAnimationFrame);
      }
    }
  } finally {
    l?.release();
    c?.release();
    r?.release();
    guide.value = null;
    match_left.value = null;
    match_right.value = null;
  }
});

function circleCenter({ x, y }: Point2d) {
  return { cx: x, cy: y };
}

onUnmounted(async () => {
  await Promise.all([actuate_task.abort(), divergence_task.abort()]);
  triple.release();
});
</script>

<template>
  <div class="cameras">
    <div class="view">
      <FrameView
        class="stream"
        :title="ROLE.L"
        :mat="mat_l"
        :theme="THEME.L"
        capture="left"
      >
      </FrameView>
      <PosView
        :pos="volt.L"
        :lim="controller?.dv ?? 200"
        :color="THEME.L"
        style="width: 100%"
      />
    </div>
    <div class="view">
      <FrameView
        class="stream"
        :mat="center_view"
        :theme="THEME.C"
        capture="center.disparity"
      >
        <template #title>
          <InlineSelect v-model="view">
            <option value="sliced">Wide Angle Sliced</option>
            <option value="disparity">Disparity (Left v.s. Right)</option>
          </InlineSelect>
        </template>
      </FrameView>
      <StreamView
        class="stream"
        :title="ROLE.C"
        :camera="C"
        :theme="THEME.C"
        capture="center"
        @mouse="(e) => (cursor = e)"
      >
        <FrameCursor
          :cursor="target"
          :undistort="undistort"
          box="dot"
          :color="THEME.C"
        />
        <FrameCursor
          box="rect"
          :cursor="{ ...L_PX, width, height }"
          :color="THEME.L"
        />
        <FrameCursor
          box="rect"
          :cursor="{ ...R_PX, width, height }"
          :color="THEME.R"
        />
        <FrameCursor v-if="cursor && !is_drag" :cursor="cursor" color="gray" />
      </StreamView>
      <div class="report">
        Vergence
        <span class="value">{{ deg(divergence).toFixed(2) }}</span
        >° | Depth <span class="value">{{ depth }}</span
        >m
      </div>
    </div>
    <div class="view">
      <FrameView
        class="stream"
        :title="ROLE.R"
        :mat="mat_r"
        :theme="THEME.R"
        capture="right"
      >
      </FrameView>
      <PosView
        :pos="volt.R"
        :lim="controller?.dv ?? 200"
        :color="THEME.R"
        style="width: 100%"
      />
    </div>
  </div>
  <div
    class="divergence"
    :style="{ paddingBottom: (drawer_height ? drawer_height + 20 : 0) + 'px' }"
  >
    <FrameView width="100%" title="Template Match Guide Strip" :mat="guide">
      <template v-if="guide">
        <rect
          v-if="match_center"
          v-bind="RECT(match_center.rect)"
          :fill="THEME.C"
          opacity="0.2"
        />
        <rect
          v-if="match_left"
          v-bind="RECT.offset(match_left.rect, -2)"
          fill="none"
          :stroke="THEME.L"
          stroke-width="2"
          opacity="0.4"
        />
        <rect
          v-if="match_right"
          v-bind="RECT.offset(match_right.rect, -2)"
          fill="none"
          :stroke="THEME.R"
          stroke-width="2"
          opacity="0.4"
        />
        <circle
          :fill="THEME.C"
          :cx="target_loc.x"
          :cy="(guide.shape[0] ?? 0) / 2"
          r="3"
        />
        <circle
          v-if="match_left"
          :fill="THEME.L"
          v-bind="circleCenter(RECT.getCenter(match_left.rect))"
          r="3"
        />
        <circle
          v-if="match_right"
          :fill="THEME.R"
          v-bind="circleCenter(RECT.getCenter(match_right.rect))"
          r="3"
        />
      </template>
    </FrameView>
    <FrameView
      width="100%"
      :title="`Left Match ${
        (match_left && RECT.getCenter(match_left.rect).x) || '--'
      }px (Red = Match, Blue = Mismatch)`"
      :mat="match_left?.mat"
    >
    </FrameView>
    <FrameView
      width="100%"
      :title="`Right Match ${
        (match_right && RECT.getCenter(match_right.rect).x) || '--'
      }px (Red = Match, Blue = Mismatch)`"
      :mat="match_right?.mat"
    >
    </FrameView>
  </div>

  <Drawer v-model="drawer_height">
    <div class="drawer-columns">
      <!-- Column 1: Global Parameters -->
      <div class="options">
        <h4>
          <span>Parameters</span>
          <button class="reset" title="Reset to defaults" @click="resetParams">
            reset
          </button>
        </h4>
        <RangeSlider
          v-model="sensitivity_ratio"
          :min="0"
          :max="1"
          :neutral="neutrals.sensitivity"
          :step="0.001"
        >
          <span>Sensitivity</span>
          <span>{{ sensitivity.toFixed(3) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="scale_ratio"
          :min="0"
          :max="1"
          :neutral="neutrals.scale_ratio"
          :step="0.01"
        >
          <span>Template Scale</span>
          <span>{{ scale.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="min_score"
          :min="0"
          :max="1"
          :neutral="neutrals.min_score"
          :step="0.01"
        >
          <span>Min Match Score</span>
          <span>{{ min_score.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="timeout_ratio"
          :min="0"
          :max="1"
          :neutral="neutrals.timeout"
          :step="0.01"
        >
          <span>Timeout</span>
          <span>
            <template v-if="timeout_ms !== Infinity">
              {{ timeout_ms }} ms
            </template>
            <template v-else> ∞ </template>
          </span>
        </RangeSlider>
        <RangeSlider
          v-model="expand_x"
          :min="1.0"
          :max="4.0"
          :neutral="neutrals.expand_x"
          :step="0.1"
          ><span>X Expansion</span
          ><span>{{ (expand_x * 100).toFixed(1) }}%</span></RangeSlider
        >
        <RangeSlider
          v-model="expand_y"
          :min="1.0"
          :max="4.0"
          :neutral="neutrals.expand_y"
          :step="0.1"
          ><span>Y Expansion</span
          ><span>{{ (expand_y * 100).toFixed(1) }}%</span></RangeSlider
        >
        <h4><span>Display</span></h4>
        <label class="entry">
          <span>Zoom Ratio</span>
          <input type="number" v-model.number="zoom" />
        </label>
        <label class="entry">
          <span>Wrap</span>
          <input type="checkbox" v-model="wrap_enable" />
        </label>
      </div>
      <!-- Column 2: Pan PID -->
      <div class="options">
        <h4>
          <span>Pan PID</span>
          <button class="reset" title="Reset to defaults" @click="resetPan">
            reset
          </button>
        </h4>
        <RangeSlider
          v-model="pan_kp"
          :min="0"
          :max="1"
          :neutral="neutrals.pan_kp"
          :step="0.01"
        >
          <span>Kp</span><span>{{ pan_kp.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="pan_ki"
          :min="0"
          :max="1"
          :neutral="neutrals.pan_ki"
          :step="0.01"
        >
          <span>Ki</span><span>{{ pan_ki.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="pan_kd"
          :min="0"
          :max="1"
          :neutral="neutrals.pan_kd"
          :step="0.01"
        >
          <span>Kd</span><span>{{ pan_kd.toFixed(2) }}</span>
        </RangeSlider>
      </div>
      <!-- Column 3: Depth PID -->
      <div class="options">
        <h4>
          <span>Depth PID</span>
          <button class="reset" title="Reset to defaults" @click="resetDepth">
            reset
          </button>
        </h4>
        <RangeSlider
          v-model="depth_kp"
          :min="0"
          :max="10"
          :neutral="neutrals.depth_kp"
          :step="0.02"
        >
          <span>Kp</span><span>{{ depth_kp.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="depth_ki"
          :min="0"
          :max="10"
          :neutral="neutrals.depth_ki"
          :step="0.02"
        >
          <span>Ki</span><span>{{ depth_ki.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="depth_kd"
          :min="0"
          :max="10"
          :neutral="neutrals.depth_kd"
          :step="0.02"
        >
          <span>Kd</span><span>{{ depth_kd.toFixed(2) }}</span>
        </RangeSlider>
      </div>
      <!-- Column 4: Vertical PID -->
      <div class="options">
        <h4>
          <span>Vertical PID</span>
          <button
            class="reset"
            title="Reset to defaults"
            @click="resetVertical"
          >
            reset
          </button>
        </h4>
        <RangeSlider
          v-model="v_shift_kp"
          :min="0"
          :max="1"
          :neutral="neutrals.v_shift_kp"
          :step="0.01"
        >
          <span>Kp</span><span>{{ v_shift_kp.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="v_shift_ki"
          :min="0"
          :max="1"
          :neutral="neutrals.v_shift_ki"
          :step="0.01"
        >
          <span>Ki</span><span>{{ v_shift_ki.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="v_shift_kd"
          :min="0"
          :max="1"
          :neutral="neutrals.v_shift_kd"
          :step="0.01"
        >
          <span>Kd</span><span>{{ v_shift_kd.toFixed(2) }}</span>
        </RangeSlider>
      </div>
      <!-- Column 5: Vergence Angles -->
      <div class="options">
        <h4>
          <span>Vergence Angles</span>
          <button
            class="reset"
            title="Reset to defaults"
            @click="resetVergence"
          >
            reset
          </button>
        </h4>
        <RangeSlider
          v-model="pids.verge.value"
          :min="pids.verge.limits[0]"
          :max="pids.verge.limits[1]"
          :neutral="0"
          :step="0.01"
        >
          <span>Verge</span>
          <span>{{ degrees(pids.verge.value).toFixed(2) }}°</span>
        </RangeSlider>
        <RangeSlider
          v-model="pids.panX.value"
          :min="pids.panX.limits[0]"
          :max="pids.panX.limits[1]"
          :neutral="0"
          :step="0.01"
        >
          <span>Pan X</span>
          <span>{{ degrees(pids.panX.value).toFixed(2) }}°</span>
        </RangeSlider>
        <RangeSlider
          v-model="pids.panY.value"
          :min="pids.panY.limits[0]"
          :max="pids.panY.limits[1]"
          :neutral="0"
          :step="0.01"
        >
          <span>Pan Y</span>
          <span>{{ degrees(pids.panY.value).toFixed(2) }}°</span>
        </RangeSlider>
        <RangeSlider
          v-model="pids.v_shift.value"
          :min="pids.v_shift.limits[0]"
          :max="pids.v_shift.limits[1]"
          :neutral="0"
          :step="0.01"
        >
          <span>V-Shift</span>
          <span>{{ degrees(pids.v_shift.value).toFixed(2) }}°</span>
        </RangeSlider>

        <fieldset class="debug">
          <legend>PID Debug</legend>
          <div>
            <span>Status</span><span>{{ status }}</span>
          </div>
          <div>
            <span>Pan&nbsp;X&nbsp;/&nbsp;Y</span>
            <span>
              {{ degrees(pids.panX.value).toFixed(3) }}° /
              {{ degrees(pids.panY.value).toFixed(3) }}°
            </span>
          </div>
          <div>
            <span>Verge</span
            ><span>{{ degrees(pids.verge.value).toFixed(4) }}</span>
          </div>
          <div>
            <span>Distance</span>
            <span>
              <template v-if="distance !== Infinity">
                {{ (distance / 1000).toFixed(3) }} m
              </template>
              <template v-else> ∞ </template>
            </span>
          </div>
          <div>
            <span>V-Shift</span
            ><span>{{ degrees(pids.v_shift.value).toFixed(3) }}°</span>
          </div>
        </fieldset>
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

.fill {
  width: 100%;
  height: 100%;
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
