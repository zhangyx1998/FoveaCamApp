<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, shallowRef, watch } from "vue";
import { Point2d, Rect, Size } from "core/Geometry";
import {
  getCameraInfo,
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
import FrameView from "@src/components/FrameView.vue";
import { RECT } from "@lib/util/geometry";
import { useAppConfig } from "@lib/config";
import { radians } from "@lib/util";
import Capture from "@src/capture";
import Recording, { RecordFrame } from "@src/record";
import {
  diff,
  disparity,
  heatmap,
  Mat,
  depthFromProjection,
  reprojectImageTo3D,
  slice,
  wrapPerspective,
  convertType,
  cvtColor,
} from "core/Vision";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import { createQMatrix, deriveFoveaIntrinsics } from "@lib/stereo";
import { matToArray } from "@lib/mat";
import { makeBGRA, stack } from "@lib/imgproc";
import Drawer from "@src/components/Drawer.vue";

import Checker from "@src/graphics/Checker.vue";
import { Frame } from "core/Aravis";
import { KCF } from "core/Tracker";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faArrowRotateLeft } from "@fortawesome/free-solid-svg-icons";
import { KinematicModel } from "./kinematic";

const view = ref<"sliced" | "diff" | "depth">("sliced");
const remote_content = ref<string>("NONE");
const checker_corners = ref(10);
const checker_size_mm = ref(10);
const app_config = await useAppConfig();
const controller = computed(getController);
const triple = await useCalibratedTriple();
const { L, C, R } = triple;
const { A2V, V2A, A2H } = useCoordinateConversions(triple);

const drawer_height = ref(0);

const { width, height } = await getFrameSize(C);
const undistort = triple.CI.undistort;
if (!undistort)
  throw new Error("Intrinsic calibration not found for center camera.");

const cursor = shallowRef<(Rect & { buttons: number }) | null>(null);
const target_loc = shallowRef<Point2d>({ x: width / 2, y: height / 2 });
const target_angle = computed(
  () => undistort.angular([target_loc.value], false)[0],
);
const target_size = computed(() => ({
  width: width / zoom.value,
  height: height / zoom.value,
}));

const zoom = computed<number>({
  get: () => Math.max(1.0, triple.config.zoom_factor ?? 9.0),
  set: (v) => (triple.config.zoom_factor = v),
});

const cap_stack = computed<number>({
  get: () => Math.max(1, Math.round(app_config.cap_stack ?? 30)),
  set: (v) => (app_config.cap_stack = Math.round(v)),
});

const verge = ref(0.0);
const shift = ref(0.0);
const depth_window_inv = ref(0.0);

const distance = computed(() =>
  verge.value <= 0 ? Infinity : baseline.value / Math.pow(verge.value, 2),
);

const baseline = computed(() => app_config.baseline_distance_mm ?? 200.0);

const depth_window = computed(() => {
  const inv = depth_window_inv.value;
  if (inv <= 0) return Infinity;
  return 1 / Math.pow(inv, 2);
});

function inverseTriangulate(angle: Point2d, z = Infinity, s = 0) {
  const out = {
    l: { ...angle },
    r: { ...angle },
  };
  if (z < Infinity && z > 0) {
    const b = baseline.value / 2;
    const x = z * Math.tan(angle.x);
    out.l.x = Math.atan2(x + b, z);
    out.r.x = Math.atan2(x - b, z);
  }
  if (s !== 0) {
    out.l.y += radians(s);
    out.r.y -= radians(s);
  }
  return out;
}

function anglesToVolts(A: { l: Point2d; r: Point2d }) {
  return {
    l: A2V.L(A.l),
    r: A2V.R(A.r),
  };
}

const target_volts = computed(() =>
  anglesToVolts(
    inverseTriangulate(target_angle.value, distance.value, shift.value),
  ),
);

// =====================================================================
// KCF Tracker State
// =====================================================================

const tracker_bbox = shallowRef<Rect | null>(null);
const tracker_active = ref(false);
const lost_tolerance = ref(10);
let tracker_instance: KCF | null = null;
let tracker_abort: (() => void) | null = null;

const tracker_size_override = shallowRef<Size | null>(null);
const tracker_size = computed<Size>(() => {
  if (tracker_size_override.value) return tracker_size_override.value;
  const { width: w, height: h } = target_size.value;
  const side = Math.round(0.5 * Math.max(w, h));
  return { width: side, height: side };
});
const tracker_w = computed<number>({
  get: () => tracker_size.value.width,
  set: (v) => {
    tracker_size_override.value = {
      width: v,
      height: tracker_size.value.height,
    };
  },
});
const tracker_h = computed<number>({
  get: () => tracker_size.value.height,
  set: (v) => {
    tracker_size_override.value = {
      width: tracker_size.value.width,
      height: v,
    };
  },
});
function resetTrackerSize() {
  tracker_size_override.value = null;
}

// Search window padding around the previous bbox (per side, in pixels).
// Cropping the frame to a tight search window dramatically reduces KCF +
// cvtColor cost compared to running them on the full sensor frame.
const pad_x_override = ref<number | null>(null);
const pad_y_override = ref<number | null>(null);
const pad_x = computed<number>({
  get: () => pad_x_override.value ?? Math.round(tracker_size.value.width),
  set: (v) => {
    pad_x_override.value = v;
  },
});
const pad_y = computed<number>({
  get: () => pad_y_override.value ?? Math.round(tracker_size.value.height),
  set: (v) => {
    pad_y_override.value = v;
  },
});
function resetSearchPad() {
  pad_x_override.value = null;
  pad_y_override.value = null;
}

const pred_buffer_max = ref(10);
const kinematic = new KinematicModel(() => pred_buffer_max.value);

function getSearchWindow(bbox: Rect, scale = 1): Rect {
  const px = Math.max(0, pad_x.value * scale);
  const py = Math.max(0, pad_y.value * scale);
  const x = Math.max(0, Math.round(bbox.x - px));
  const y = Math.max(0, Math.round(bbox.y - py));
  const right = Math.min(width, Math.round(bbox.x + bbox.width + px));
  const bottom = Math.min(height, Math.round(bbox.y + bbox.height + py));
  return { x, y, width: right - x, height: bottom - y };
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
  kinematic.reset();
}

function startTracker(center: Point2d) {
  releaseTracker();

  const frame = mat_c.value;
  if (!frame) return;

  // BBox centered at click location, sized to configured tracker size
  const bboxSize = tracker_size.value;
  const roi: Rect = RECT.fromCenter(
    undistort!.position([undistort!.angular([center], false)[0]], false)[0],
    bboxSize,
  );

  // Clamp roi to frame bounds
  const x = Math.max(0, Math.round(roi.x));
  const y = Math.max(0, Math.round(roi.y));
  const w = Math.min(width - x, Math.round(roi.width));
  const h = Math.min(height - y, Math.round(roi.height));
  if (w <= 0 || h <= 0) return;

  const clampedRoi = { x, y, width: w, height: h };

  // Crop a search window around the bbox so KCF/cvtColor run on a small
  // patch instead of the full sensor frame.
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

  // Seed prediction buffer with the initial observation.
  kinematic.reset();
  kinematic.push(center.x, center.y, performance.now());

  // Run tracker loop
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

      // Expand search window after each consecutive miss so a sudden
      // jump that exits the tight crop can still be recovered.
      const search = getSearchWindow(currentBbox, 1 + lost_count);
      const patch = cvtColor(slice(currentFrame, search), "BGRA2BGR");
      const result = tracker.update(patch);

      if (result) {
        lost_count = 0;
        // Translate bbox from patch-local coords back to full-frame coords.
        const fullBbox: Rect = {
          x: result.x + search.x,
          y: result.y + search.y,
          width: result.width,
          height: result.height,
        };
        currentBbox = fullBbox;
        tracker_bbox.value = fullBbox;
        const bboxCenter = RECT.getCenter(fullBbox);
        last_good_center = bboxCenter;
        const now = performance.now();
        kinematic.push(bboxCenter.x, bboxCenter.y, now);
        target_loc.value = kinematic.predict(now) ?? bboxCenter;
      } else {
        lost_count++;
        if (lost_count >= lost_tolerance.value) {
          // Point mirrors to last known location and stop
          target_loc.value = last_good_center;
          releaseTracker();
          return;
        }
      }
    }
  };

  loop().catch(console.error);
}

// =====================================================================
// Mouse Interaction
// =====================================================================

// When user presses mouse, disengage tracker immediately.
// When user releases mouse, start new tracker at that location.
const is_dragging = ref(false);

watch(cursor, (c) => {
  if (c) {
    // Mouse is down / dragging — disengage tracker, update target
    if (!is_dragging.value) {
      is_dragging.value = true;
      releaseTracker();
    }
    const { x, y } = c;
    target_loc.value = { x, y };
  } else if (is_dragging.value) {
    // Mouse released — start tracker at current target location
    is_dragging.value = false;
    startTracker(target_loc.value);
  }
});

const volt = reactive({
  L: { x: 0, y: 0 },
  R: { x: 0, y: 0 },
});

const actuate_task = abortable(async (_, onAbort) => {
  const c = controller.value;
  if (!c) return;
  let aborted = false;
  onAbort(() => {
    aborted = true;
  });
  const tasks = new Set<Promise<any>>();
  try {
    await c.enable();
    while (!aborted) {
      // Re-evaluate the kinematic model at "now" so the mirror keeps
      // tracking smoothly between (slower) tracker updates — decouples
      // actuation cadence from tracker fps.
      const pred = kinematic.predict(performance.now());
      if (pred) target_loc.value = pred;
      const { l, r } = target_volts.value;
      // const { left, right } = await c.actuate({ left: l, right: r });
      // volt.L = left;
      // volt.R = right;
      const task = c.actuate({ left: l, right: r }).then(({ left, right }) => {
        volt.L = left;
        volt.R = right;
        tasks.delete(task);
      });
      tasks.add(task);
      await new Promise((r) => setTimeout(r, 1)); // Actuation interval (ms)
      console.log("Pending actuation:", tasks.size);
    }
  } finally {
    await Promise.allSettled(tasks);
    await c.disable();
  }
});

onUnmounted(async () => {
  releaseTracker();
  await Promise.all([actuate_task.abort()]);
  await recording.stop();
  triple.release();
});

const mat_l = shallowRef<Mat<Uint8Array> | null>(null);
const mat_c = shallowRef<Mat<Uint8Array> | null>(null);
const mat_r = shallowRef<Mat<Uint8Array> | null>(null);

const sliced_view = computed(() => {
  const m = mat_c.value;
  if (!m) return null;
  const rect = RECT.fromCenter(
    undistort.position([target_angle.value], false)[0],
    target_size.value,
  );
  return slice(m, rect);
});

const diff_view = computed(() => {
  const [l, r] = [mat_l.value, mat_r.value];
  if (!l || !r) return null;
  return diff(l, r, true);
});

const fovea_intrinsics = computed(() => {
  const A = {
    L: V2A.L(volt.L),
    R: V2A.R(volt.R),
  };
  return {
    L: deriveFoveaIntrinsics(undistort, A.L, zoom.value),
    R: deriveFoveaIntrinsics(undistort, A.R, zoom.value),
  };
});

const Q = computed(() =>
  createQMatrix(
    fovea_intrinsics.value.L,
    fovea_intrinsics.value.R,
    baseline.value,
  ),
);

const depth_view = computed(() => {
  const [l, r] = [mat_l.value, mat_r.value];
  if (!l || !r) return null;
  const d = disparity(l, r);
  const proj = reprojectImageTo3D(d, Q.value);
  const dist = distance.value;
  const dw = depth_window.value / 2;
  const z = depthFromProjection(proj, dist - dw, dist + dw);
  return heatmap(z);
});

const center_view = computed(() => {
  switch (view.value) {
    case "sliced":
    default:
      return sliced_view.value;
    case "diff":
      return diff_view.value;
    case "depth":
      return depth_view.value;
  }
});

const wrap_enable = ref(true);

function wrapLeft(mat: Mat<Uint8Array>) {
  if (!wrap_enable.value) return (mat_l.value = mat);
  const A = V2A.L(volt.L);
  const H = A2H.L(A);
  return (mat_l.value = wrapPerspective(mat, H));
}

function transformCenter(mat: Mat<Uint8Array>) {
  mat = undistort!.apply(mat);
  return (mat_c.value = mat);
}

function wrapRight(mat: Mat<Uint8Array>) {
  if (!wrap_enable.value) return (mat_r.value = mat);
  const A = V2A.R(volt.R);
  const H = A2H.R(A);
  return (mat_r.value = wrapPerspective(mat, H));
}

function plusSign(v: string) {
  return v.startsWith("-") ? v : "+" + v;
}

const capture = new Capture("manual-control");
const recording = new Recording("manual-control", {
  C: getCameraInfo(triple.C),
  L: getCameraInfo(triple.L),
  R: getCameraInfo(triple.R),
});

function emitRecFrame(
  name: string,
  frame: Frame,
  fovea?: {
    V: Point2d;
    A: Point2d;
    H: Mat<Float64Array>;
  },
): RecordFrame {
  const { raw, raw_format: format } = frame;
  frame.release();
  const meta: Record<string, any> = {};
  if (fovea)
    Object.assign(meta, {
      volt: { ...fovea.V },
      "volt.unit": "volt",
      angle: { ...fovea.A },
      "angle.unit": "radian",
      affine: matToArray(fovea.H),
    });
  return { name, frame: raw, format, meta };
}

recording.provide(async function* (live) {
  for await (const frame of L.stream) {
    if (!live()) return;
    const V = volt.L;
    const A = V2A.L(V);
    const H = A2H.L(A);
    yield emitRecFrame("left-fovea", frame, { V, A, H });
  }
});

recording.provide(async function* (live) {
  for await (const frame of C.stream) {
    if (!live()) return;
    yield emitRecFrame("center", frame);
  }
});

recording.provide(async function* (live) {
  for await (const frame of R.stream) {
    if (!live()) return;
    const V = volt.R;
    const A = V2A.R(V);
    const H = A2H.R(A);
    yield emitRecFrame("right-fovea", frame, { V, A, H });
  }
});

type Stack = Awaited<ReturnType<typeof stack>>;
function normalizeFovea({ image, format }: Stack, H: Mat<Float64Array>) {
  const bgra = makeBGRA(convertType(image, "16U"), format);
  if (wrap_enable.value) return wrapPerspective(bgra, H);
  else return bgra;
}

async function* captureFoveaPair(sensor_size: Size) {
  const fovea = {
    Q: matToArray(Q.value),
    baseline: baseline.value,
    "baseline.unit": "millimeter",
  };
  yield { name: "fovea", meta: fovea };
  yield { name: "center", image: sliced_view.value };
  // Snapshot volts and angles
  const V = { ...volt };
  const A = {
    L: V2A.L(V.L),
    R: V2A.R(V.R),
  };
  const [l_stack, r_stack] = await Promise.all([
    stack(L.stream, cap_stack.value),
    stack(R.stream, cap_stack.value),
  ]);
  const l = normalizeFovea(l_stack, A2H.L(A.L));
  const r = normalizeFovea(r_stack, A2H.R(A.R));
  const intrinsics = fovea_intrinsics.value;
  yield {
    name: "left",
    image: l,
    meta: {
      sensor_size,
      volt: V.L,
      "volt.unit": "volt",
      angle: A.L,
      "angle.unit": "radian",
      intrinsics: intrinsics.L,
    },
  };
  yield {
    name: "right",
    image: r,
    meta: {
      sensor_size,
      volt: V.R,
      "volt.unit": "volt",
      angle: A.R,
      "angle.unit": "radian",
      intrinsics: intrinsics.R,
    },
  };
  yield { name: "diff", image: diff(l, r, true) };
}

capture.provide(async (provide) => {
  const { sensor_size, focal, center, fov } = undistort;
  provide("wide", { meta: { sensor_size, focal, center, fov } });
  for await (const { name, ...content } of captureFoveaPair(sensor_size))
    provide(name, content);
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
        :camera="L"
        :transform="wrapLeft"
        :theme="THEME.L"
      >
      </StreamView>
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
        :title="ROLE.C + ' (' + view + ')'"
        :mat="center_view"
        :theme="THEME.C"
      />
      <StreamView
        class="stream"
        :title="ROLE.C"
        :camera="C"
        :transform="transformCenter"
        :theme="THEME.C"
        capture="wide"
        v-model="cursor"
      >
        <FrameCursor
          :cursor="{ ...target_loc, width, height }"
          :undistort="undistort"
          box="dot"
          :color="THEME.C"
        />
        <FrameCursor
          v-if="cursor && !is_dragging"
          :cursor="cursor"
          :undistort="undistort"
          color="#fffa"
        />
        <!-- Tracker bounding box visualization -->
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
      <ConfigEntry>
        <label>
          <span>Zoom</span>
          <input v-model.number="zoom" style="width: 4ch" />
        </label>
        <span>|</span>
        <label>
          <span>View</span>
          <select v-model="view">
            <option value="sliced">Sliced</option>
            <option value="diff">Diff</option>
            <option value="depth">Depth</option>
          </select>
        </label>
        <span>|</span>
        <label>
          <span>Wrap</span>
          <input type="checkbox" v-model="wrap_enable" />
        </label>
        <span>|</span>
        <button
          v-if="tracker_active"
          class="release-btn"
          @click="releaseTracker"
        >
          Release Tracker
        </button>
        <span v-else class="tracker-idle">No Tracker</span>
      </ConfigEntry>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.R"
        :camera="R"
        :transform="wrapRight"
        :theme="THEME.R"
      >
      </StreamView>
      <PosView
        :pos="volt.R"
        :lim="controller?.dv ?? 200"
        :color="THEME.R"
        style="width: 100%"
      />
    </div>
  </div>
  <Drawer v-model="drawer_height">
    <div class="options fill">
      <RangeSlider v-model="verge" :min="1" :max="0" :neutral="0" :step="0.01">
        <span>Verge Distance</span>
        <span>
          <template v-if="distance !== Infinity">
            {{ (distance / 1000).toFixed(4) }}m
          </template>
          <template v-else> &#x221E; </template>
        </span>
      </RangeSlider>
      <RangeSlider
        v-model="shift"
        :min="-0.5"
        :max="+0.5"
        :neutral="0"
        :step="0.1"
      >
        <span>Vertical Shift</span>
        <span> {{ plusSign(shift.toFixed(4)) }}&deg; </span>
      </RangeSlider>
      <RangeSlider
        v-model="depth_window_inv"
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
        v-model="lost_tolerance"
        :min="1"
        :max="60"
        :neutral="10"
        :step="1"
      >
        <span>Lost Tolerance</span>
        <span>{{ lost_tolerance }} frames</span>
      </RangeSlider>
      <RangeSlider
        v-model="pred_buffer_max"
        :min="4"
        :max="50"
        :neutral="10"
        :step="1"
      >
        <span>Predict Samples</span>
        <span>{{ pred_buffer_max }} samples</span>
      </RangeSlider>
      <ConfigEntry>
        <label>
          <span>Tracker Size</span>
          <input v-model.number="tracker_w" style="width: 5ch" />
          <span>&times;</span>
          <input v-model.number="tracker_h" style="width: 5ch" />
        </label>
        <button
          class="reset-btn"
          title="Reset to default"
          @click="resetTrackerSize"
        >
          <Icon :icon="faArrowRotateLeft" />
        </button>
      </ConfigEntry>
      <ConfigEntry>
        <label>
          <span>Search Pad</span>
          <input v-model.number="pad_x" style="width: 5ch" />
          <span>&times;</span>
          <input v-model.number="pad_y" style="width: 5ch" />
        </label>
        <button
          class="reset-btn"
          title="Reset to default"
          @click="resetSearchPad"
        >
          <Icon :icon="faArrowRotateLeft" />
        </button>
      </ConfigEntry>
      <RangeSlider
        v-model="cap_stack"
        :min="1"
        :max="200"
        :neutral="1"
        :step="10"
      >
        <span>Capture Stack</span>
        <span>{{ cap_stack }}</span>
      </RangeSlider>
      <ConfigEntry>
        <label>
          <span>Remote Display</span>
          <select v-model="remote_content">
            <option value="NONE">No Content</option>
            <option value="L+R">L + R</option>
            <option value="checker">Checker</option>
          </select>
        </label>
      </ConfigEntry>
      <template v-if="remote_content === 'checker'">
        <RangeSlider
          v-model="checker_corners"
          :min="1"
          :max="20"
          :neutral="6"
          :step="1"
        >
          <span>Checker</span>
          <span>{{ checker_corners }} Corners</span>
        </RangeSlider>
        <RangeSlider
          v-model="checker_size_mm"
          :min="1"
          :max="100"
          :neutral="10"
          :step="1"
        >
          <span>Checker Size</span>
          <span>{{ checker_size_mm }} mm</span>
        </RangeSlider>
      </template>
    </div>
  </Drawer>
  <RemoteCanvasTeleport>
    <template v-if="remote_content === 'L+R'">
      <rect
        x="-150"
        y="-50"
        width="100"
        height="100"
        fill="none"
        stroke="white"
        stroke-width="4"
      />
      <rect
        x="50"
        y="-50"
        width="100"
        height="100"
        fill="none"
        stroke="white"
        stroke-width="4"
      />
      <line x1="-20" x2="20" stroke="white" stroke-width="4"></line>
      <line y1="-20" y2="20" stroke="white" stroke-width="4"></line>
      <text x="-100" y="8" font-size="100">L</text>
      <text x="100" y="8" font-size="100">R</text>
    </template>
    <Checker
      v-if="remote_content === 'checker'"
      :M="checker_corners"
      :invert="true"
      :size="checker_size_mm"
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

.release-btn {
  background: none;
  border: 1px solid #0f0;
  color: #0f0;
  padding: 0.1em 0.6em;
  cursor: pointer;
  font-size: 0.85em;
  border-radius: 3px;
  &:hover {
    background: #0f02;
  }
}

.tracker-idle {
  color: #666;
  font-size: 0.85em;
}

.reset-btn {
  background: none;
  border: none;
  color: #888;
  padding: 0.1em 0.4em;
  cursor: pointer;
  font-size: 0.85em;
  border-radius: 3px;
  &:hover {
    color: #ccc;
    background: #8882;
  }
}
</style>
