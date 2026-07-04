<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, shallowRef, watch } from "vue";
import { Point2d, Rect } from "core/Geometry";
import { Mat, slice, diff, wrapPerspective, cvtColor } from "core/Vision";
import { Frame } from "core/Aravis";
import { KCF } from "core/Tracker";
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
import { Zip } from "@lib/util/iter";
import FrameView from "@src/components/FrameView.vue";
import InlineSelect from "@src/components/InlineSelect.vue";
import Drawer from "@src/components/Drawer.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import { RECT } from "@lib/util/geometry";
import { useAppConfig } from "@lib/config";
import local, { type Local } from "@lib/local";
import { clamp, degrees, radians } from "@lib/util";
import {
  distanceToVerge,
  vergeToDistance,
  vergenceToDistance,
} from "@lib/stereo";
import { PID } from "@lib/pid";
import { logScale } from "@lib/conversion";
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

// Template-match scale, confidence gate, and master responsiveness, persisted
// in localStorage (like the PID gains) so tuning is independent of app config.
const scale_ratio = local("disparity-scope.controls.scale", 0);
const min_score = local("disparity-scope.controls.min_score", 0.1);
// sensitivity = control time step per ms elapsed (absorbs the old
// nominal-fps × ms→s scaling). Larger = faster convergence, less damping.
const sensitivity = local("disparity-scope.controls.sensitivity", 1.0);

const sensitivityScale = logScale(0.1, 10.0);
const sensitivity_ratio = computed<number>({
  get: () => sensitivityScale.toRatio(sensitivity.value),
  set: (r) => (sensitivity.value = sensitivityScale.fromRatio(r)),
});

// Guide expansion around target tile
const expand_x = local("disparity-scope.controls.expand_x", 3.0);
const expand_y = local("disparity-scope.controls.expand_y", 2.0);

// Auto-vergence convergence timeout. The slider is exponential over
// [100, 10000] ms, with the far-right end (ratio === 1) mapping to 0 = "no
// timeout" (iterate forever). timeout_ms_local persists it (default 2000ms).
const timeoutScale = logScale(100, 10000, { infinityAt: 0, round: true });
const timeout_ms_local = local("disparity-scope.controls.timeout", 2000);
const timeout_ratio = computed<number>({
  get: () => timeoutScale.toRatio(timeout_ms_local.value),
  set: (r) => (timeout_ms_local.value = timeoutScale.fromRatio(r)),
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
  // While actively tracking, never freeze — the mirrors should keep following
  // the tracked object.
  if (tracker_active.value) return false;
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
// One UI column per gain group. Each builds its own {kp, ki, kd} local refs,
// syncs them onto the listed PID controllers (pan drives both shift axes), and
// the template renders the column + reset button by iterating this table —
// adding a DOF is a single entry, not three scattered edits.
type GainGroup = {
  key: string;
  title: string;
  /** Slider range and step shared by all three terms. */
  range: [number, number];
  step: number;
  /** kp / ki / kd, in order. */
  terms: [Local<number>, Local<number>, Local<number>];
};
function gainGroup(
  key: string,
  title: string,
  defaults: [number, number, number],
  range: [number, number],
  step: number,
  targets: PID[],
): GainGroup {
  const terms = (["kp", "ki", "kd"] as const).map((t, i) =>
    gain(key, t, defaults[i]),
  ) as GainGroup["terms"];
  watch(
    terms,
    ([p, i, d]) => targets.forEach((t) => ((t.kp = p), (t.ki = i), (t.kd = d))),
    { immediate: true },
  );
  return { key, title, range, step, terms };
}
const gainGroups: GainGroup[] = [
  gainGroup("pan", "Pan PID", [0.02, 0.02, 0], [0, 1], 0.01, [
    pids.panX,
    pids.panY,
  ]),
  gainGroup("depth", "Depth PID", [1.0, 0.2, 0.5], [0, 10], 0.02, [pids.verge]),
  gainGroup("v_shift", "Vertical PID", [0.02, 0.02, 0], [0, 1], 0.01, [
    pids.v_shift,
  ]),
];

// Parameter refs, grouped so the template can read each `.default` for its
// slider neutral and the reset button can revert them all in one call.
const params = {
  sensitivity,
  scale_ratio,
  min_score,
  timeout_ms_local,
  expand_x,
  expand_y,
};
const resetParams = () => Object.values(params).forEach((r) => r.reset());
const resetGroup = (g: GainGroup) => g.terms.forEach((r) => r.reset());
const resetVergence = () => Object.values(pids).forEach((p) => p.reset());

// On mouse release: restart the convergence window and reset every controller
// so the foveas re-converge fresh on the new target (no stale integrator wind-up).
watch(is_drag, (dragging, wasDragging) => {
  // Pressing the mouse disengages any active tracker so the user can re-aim.
  if (dragging && !wasDragging) releaseTracker();
  if (wasDragging && !dragging) {
    window_start.value = performance.now();
    for (const pid of Object.values(pids)) pid.reset();
    // Releasing re-engages the tracker at the new target, if enabled.
    if (tracker_enable.value) startTracker(target_loc.value);
  }
});

const status = ref<string>("initializing");
// Commanded convergence distance — what the verge PID is aiming for.
const commandedDistance = computed(() =>
  vergeToDistance(pids.verge.value, app_config.baseline_distance_mm),
);

const guide = ref<Mat<Uint8Array> | null>(null);

const match_left = shallowRef<MatchResult | null>(null);
const match_right = shallowRef<MatchResult | null>(null);
const match_center = shallowRef<{ rect: Rect } | null>(null);

// Realized geometry, read back from the actual mirror voltages (feedback, not
// command): the horizontal toe-in angle and the distance it triangulates to.
const vergence = computed(() => V2A.L(volt.L).x - V2A.R(volt.R).x);
const realizedDistance = computed(() =>
  vergenceToDistance(vergence.value, app_config.baseline_distance_mm / 1000),
);

// Per-eye projection of the current mirror pose into wide-frame pixels.
const PX = (role: "L" | "R") => A2P.C(V2A[role](volt[role]));
const L_PX = computed(() => PX("L"));
const R_PX = computed(() => PX("R"));

const wrap_enable = ref(true);
// Perspective-rectify a fovea frame onto its current pointing pose. Identical
// for both eyes apart from the role-indexed conversions.
function wrap(role: "L" | "R", mat: Mat<Uint8Array>) {
  if (!wrap_enable.value) return mat;
  const A = V2A[role](volt[role]);
  return wrapPerspective(mat, A2H[role](A));
}

const mat_l = ref<Mat<Uint8Array> | null>(null);
const mat_c = ref<Mat<Uint8Array> | null>(null);
const mat_r = ref<Mat<Uint8Array> | null>(null);
const raw_l = shallowRef<Mat<Uint8Array> | null>(null);
const raw_c = shallowRef<Mat<Uint8Array> | null>(null);
const raw_r = shallowRef<Mat<Uint8Array> | null>(null);

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

// =====================================================================
// Optional KCF tracker on the wide-angle (center) view. Interaction is ported
// from the single-object tracking demo: pressing the mouse disengages any
// active tracker; releasing (re)starts one at the target — but only while the
// tracker is enabled via the drawer toggle. The tracked bbox center drives
// `target_loc`, so auto-vergence follows the tracked object.
// =====================================================================
const tracker_enable = ref(false);
const tracker_active = ref(false);
const tracker_bbox = shallowRef<Rect | null>(null);
// Configurable KCF template (kernel) size, persisted in localStorage.
const kernel_w = local("disparity-scope.tracker.kernel_w", 64);
const kernel_h = local("disparity-scope.tracker.kernel_h", 64);
const TRACKER_LOST_TOLERANCE = 10;
let tracker_instance: KCF | null = null;
let tracker_abort: (() => void) | null = null;

// Crop a search window around the bbox so KCF/cvtColor run on a small patch
// instead of the full sensor frame; padding grows after consecutive misses.
function getSearchWindow(bbox: Rect, scale = 1): Rect {
  const px = Math.max(0, kernel_w.value * scale);
  const py = Math.max(0, kernel_h.value * scale);
  return RECT.clampTo(RECT.offset(bbox, { x: px, y: py }), { width, height });
}

function releaseTracker() {
  if (tracker_abort) {
    tracker_abort();
    tracker_abort = null;
  }
  if (tracker_instance) {
    tracker_instance.release();
    tracker_instance = null;
  }
  tracker_bbox.value = null;
  tracker_active.value = false;
}

function startTracker(center: Point2d) {
  releaseTracker();
  const frame = mat_c.value;
  if (!frame) return;

  // BBox centered at the target, sized to the configured kernel; clamped to
  // frame bounds.
  const clampedRoi = RECT.clampTo(
    RECT.fromCenter(center, { width: kernel_w.value, height: kernel_h.value }),
    { width, height },
  );
  if (clampedRoi.width <= 0 || clampedRoi.height <= 0) return;

  const initSearch = getSearchWindow(clampedRoi);
  const initPatch = cvtColor(slice(frame, initSearch), "BGRA2BGR");
  const roiInPatch: Rect = {
    x: clampedRoi.x - initSearch.x,
    y: clampedRoi.y - initSearch.y,
    width: clampedRoi.width,
    height: clampedRoi.height,
  };
  const tracker = new KCF();
  tracker.init(initPatch, roiInPatch);
  tracker_instance = tracker;
  tracker_bbox.value = clampedRoi;
  tracker_active.value = true;

  let lost_count = 0;
  let last_good_center = center;
  let aborted = false;
  let currentBbox: Rect = clampedRoi;
  tracker_abort = () => {
    aborted = true;
  };

  const loop = async () => {
    while (!aborted && tracker_active.value) {
      await new Promise(requestAnimationFrame);
      const currentFrame = mat_c.value;
      if (!currentFrame || aborted) break;
      // Expand the search window after each consecutive miss so a sudden jump
      // out of the tight crop can still be recovered.
      const search = getSearchWindow(currentBbox, 1 + lost_count);
      const patch = cvtColor(slice(currentFrame, search), "BGRA2BGR");
      const result = tracker.update(patch);
      if (result) {
        lost_count = 0;
        const fullBbox: Rect = {
          x: result.x + search.x,
          y: result.y + search.y,
          width: result.width,
          height: result.height,
        };
        currentBbox = fullBbox;
        tracker_bbox.value = fullBbox;
        const c = RECT.getCenter(fullBbox);
        last_good_center = c;
        // Only move the target/guide center. This shifts the template-match
        // window, so the matched fovea positions now lag the target — and the
        // vergence PID drives the mirrors to re-align (follow). The PID owns
        // the mirror; the tracker never commands it directly. `frozen()`
        // already keeps the loop unfrozen while `tracker_active`.
        target_loc.value = c;
      } else {
        lost_count++;
        if (lost_count >= TRACKER_LOST_TOLERANCE) {
          target_loc.value = last_good_center;
          releaseTracker();
          return;
        }
      }
    }
  };
  loop().catch(console.error);
}

// Toggling off releases the tracker; toggling on engages immediately at the
// current target (unless the user is mid-drag, in which case release handles it).
watch(tracker_enable, (on) => {
  if (!on) releaseTracker();
  else if (!is_drag.value) startTracker(target_loc.value);
});

// Single control loop: the sole owner of the controller's enable/disable
// lifecycle and the only caller of `actuate`. Per frame it (1) analyzes the
// triple for the live match overlay, then (2) drives the mirrors in exactly one
// mode — manual pointing while the user drags, frozen after the timeout, or
// constrained auto-vergence otherwise.
const control_task = abortable(async (aborted) => {
  const zip = new Zip(L.stream, C.stream, R.stream);
  let l: Frame | null = null,
    c: Frame | null = null,
    r: Frame | null = null;
  // Wall-clock reference for the previous *vergence* step. It advances only when
  // a step actually runs, so any pause (drag, freeze, low score) makes the next
  // step see a large — but DT_MAX_FRAMES-capped — dt instead of integrating the
  // skipped frames or kicking the derivative.
  let last_step = performance.now();
  // The controller currently held enabled by this loop (it can connect/swap at
  // runtime); kept in sync so we enable on acquire and disable on teardown.
  // An object holder (not a bare `let`) so TS keeps the union type across the
  // closure that mutates it.
  const held: { ctrl: ReturnType<typeof getController> } = { ctrl: null };
  async function ensureEnabled(ctrl: ReturnType<typeof getController>) {
    if (ctrl === held.ctrl) return;
    if (held.ctrl) await held.ctrl.disable();
    held.ctrl = ctrl;
    if (ctrl) await ctrl.enable();
  }

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

    const ctrl = controller.value;
    await ensureEnabled(ctrl);
    if (!ctrl) {
      status.value = "no controller";
      return;
    }
    async function command(left: Point2d, right: Point2d) {
      try {
        const pos = await ctrl!.actuate({ left, right });
        volt.L = { ...pos.left };
        volt.R = { ...pos.right };
      } catch (e) {
        console.warn("Mirror actuation failed:", e);
      }
    }

    // Manual: while the user drags, the foveas follow the pointer at zero verge.
    // The is_drag watcher resets the PIDs on release, so auto-vergence resumes
    // fresh with no accumulated error (and last_step is left stale → no kick).
    if (is_drag.value) {
      status.value = "manual";
      const [ray] = undistort!.angular([target_loc.value], true);
      await command(A2V.L(ray), A2V.R(ray));
      return;
    }
    // Frozen after the convergence timeout: hold the current pose.
    if (frozen()) {
      status.value = "frozen";
      return;
    }
    // Rate-normalized control time step (sensitivity bakes in the ms→step
    // scaling), capped so a stall / un-freeze can't dump a huge catch-up step.
    const now = performance.now();
    const dt = Math.min((now - last_step) * sensitivity.value, DT_MAX_FRAMES);
    const result = stepVergence(
      analysis,
      pids,
      { P2A, A2V },
      { baseline: app_config.baseline_distance_mm, minScore: min_score.value },
      dt,
    );
    // Hold position when the match is too weak to trust. last_step is left
    // unadvanced so the next trusted frame doesn't integrate this gap, and the
    // integrators are preserved (no snap on a one-frame glitch).
    if (!result) {
      status.value = "low score";
      return;
    }
    last_step = now;
    status.value = "tracking";
    await command(result.left, result.right);
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
          l.view("BGRA8", raw_l.value).then((m) => {
            raw_l.value = m;
            return wrap("L", m);
          }),
          c.view("BGRA8", raw_c.value).then((m) => {
            raw_c.value = m;
            return m;
          }),
          r.view("BGRA8", raw_r.value).then((m) => {
            raw_r.value = m;
            return wrap("R", m);
          }),
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
    if (held.ctrl) await held.ctrl.disable();
    guide.value = null;
    match_left.value = null;
    match_right.value = null;
  }
});

function circleCenter({ x, y }: Point2d) {
  return { cx: x, cy: y };
}

onUnmounted(async () => {
  releaseTracker();
  await control_task.abort();
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
        <!-- Tracker bounding box -->
        <rect
          v-if="tracker_bbox"
          :x="tracker_bbox.x"
          :y="tracker_bbox.y"
          :width="tracker_bbox.width"
          :height="tracker_bbox.height"
          stroke="#0f0"
          :stroke-width="Math.max(width, height) * 0.003"
          fill="none"
        />
      </StreamView>
      <div class="report">
        Vergence
        <span class="value">{{ degrees(vergence).toFixed(2) }}</span
        >° | Depth
        <span class="value">{{
          realizedDistance === Infinity ? "∞" : realizedDistance.toFixed(4)
        }}</span
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
          :neutral="sensitivityScale.toRatio(params.sensitivity.default)"
          :step="0.001"
        >
          <span>Sensitivity</span>
          <span>{{ sensitivity.toFixed(3) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="scale_ratio"
          :min="0"
          :max="1"
          :neutral="params.scale_ratio.default"
          :step="0.01"
        >
          <span>Template Scale</span>
          <span>{{ scale.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="min_score"
          :min="0"
          :max="1"
          :neutral="params.min_score.default"
          :step="0.01"
        >
          <span>Min Match Score</span>
          <span>{{ min_score.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="timeout_ratio"
          :min="0"
          :max="1"
          :neutral="timeoutScale.toRatio(params.timeout_ms_local.default)"
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
          :neutral="params.expand_x.default"
          :step="0.1"
          ><span>X Expansion</span
          ><span>{{ (expand_x * 100).toFixed(1) }}%</span></RangeSlider
        >
        <RangeSlider
          v-model="expand_y"
          :min="1.0"
          :max="4.0"
          :neutral="params.expand_y.default"
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
      <!-- Columns 2-4: per-DOF gain PIDs (Pan / Depth / Vertical) -->
      <div class="options" v-for="g in gainGroups" :key="g.key">
        <h4>
          <span>{{ g.title }}</span>
          <button
            class="reset"
            title="Reset to defaults"
            @click="resetGroup(g)"
          >
            reset
          </button>
        </h4>
        <RangeSlider
          v-for="(term, i) in g.terms"
          :key="i"
          :model-value="term.value"
          @update:model-value="term.value = $event"
          :min="g.range[0]"
          :max="g.range[1]"
          :neutral="term.default"
          :step="g.step"
        >
          <span>{{ ["Kp", "Ki", "Kd"][i] }}</span
          ><span>{{ term.value.toFixed(2) }}</span>
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
            <span>Distance (cmd)</span>
            <span>
              <template v-if="commandedDistance !== Infinity">
                {{ (commandedDistance / 1000).toFixed(3) }} m
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
      <!-- Column 6: Wide-angle Tracker -->
      <div class="options">
        <h4>
          <span>Tracker</span>
          <button
            class="reset toggle"
            :class="{ active: tracker_enable }"
            :title="tracker_enable ? 'Disable tracker' : 'Enable tracker'"
            @click="tracker_enable = !tracker_enable"
          >
            {{ tracker_enable ? "on" : "off" }}
          </button>
        </h4>
        <label class="entry">
          <span>Kernel</span>
          <span class="kernel-size">
            <input type="number" v-model.number="kernel_w" min="8" />
            <span>×</span>
            <input type="number" v-model.number="kernel_h" min="8" />
          </span>
        </label>
        <div class="entry">
          <span>Status</span>
          <span>{{
            tracker_active ? "tracking" : tracker_enable ? "armed" : "off"
          }}</span>
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

      // Enable toggle (Tracker column): green when on.
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
