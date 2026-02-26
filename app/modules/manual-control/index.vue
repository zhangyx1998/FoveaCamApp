<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, shallowRef, watch } from "vue";
import { Point2d, Rect, Size } from "core/Geometry";
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
import { Latest } from "@lib/util/iter";
import FrameView from "@src/components/FrameView.vue";
import { RECT } from "@lib/util/geometry";
import { useAppConfig } from "@lib/config";
import { delay, isEmpty, radians } from "@lib/util";
import Capture from "@src/capture";
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
} from "core/Vision";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import { createQMatrix, deriveFoveaIntrinsics } from "@lib/stereo";
import { matToArray } from "@lib/mat";
import { makeBGRA, stack } from "@lib/imgproc";
import Drawer from "@src/components/Drawer.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import SetPoints from "@src/set-points";
import SetPointsEditor from "@src/set-points/Editor.vue";
import SetPointsList from "@src/set-points/List.vue";
import Line2D from "@src/components/Line2D.vue";
import { Scale } from "@lib/util/math";
import local from "@lib/local";

const view = ref<"sliced" | "diff" | "depth">("sliced");
const remote_content = ref<string>("NONE");
const app_config = await useAppConfig();
const controller = computed(getController);
const triple = await useCalibratedTriple();
const { L, C, R } = triple;
const { A2V, V2A, A2H } = useCoordinateConversions(triple);

const points = new SetPoints(local("manual-control.set-points", ""));
const drawer_height = ref(0);

const { width, height } = await getFrameSize(C);
const undistort = triple.CI.undistort;
if (!undistort)
  throw new Error("Intrinsic calibration not found for center camera.");

const cursor = shallowRef<(Rect & { buttons: number }) | null>(null);
const target_loc = shallowRef<Point2d>({ x: width / 2, y: height / 2 });
const target_angle = computed(() => {
  if (setpoint_item.value) {
    const { x = 0, y = 0 } = setpoint_item.value;
    return { x: radians(x), y: radians(y) };
  } else {
    return undistort.angular([target_loc.value], false)[0];
  }
});
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

watch(verge, () => interactOverride(!isEmpty(setpoint_item.value?.d)));
watch(shift, () => interactOverride(!isEmpty(setpoint_item.value?.s)));

const baseline = computed(() => app_config.baseline_distance_mm ?? 200.0);

const depth_window = computed(() => {
  const inv = depth_window_inv.value;
  if (inv <= 0) return Infinity;
  return 1 / Math.pow(inv, 2);
});

function inverseTriangulate(angle: Point2d, z = Infinity, s = 0) {
  console.log("Get Target Volt:", { angle, z, s });
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

const target_volts = computed(() => {
  const i = setpoint.value;
  if (i !== null && i < setpoint_volts.value.length)
    return setpoint_volts.value[i];
  else
    return anglesToVolts(
      inverseTriangulate(target_angle.value, distance.value, shift.value),
    );
});

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
const setpoint_pos = computed(() => {
  const i = setpoint_item.value;
  if (isEmpty(i)) return {};
  const { x = 0, y = 0 } = i;
  return undistort.position([{ x: radians(x), y: radians(y) }], false)[0];
});
const setpoint_volts = computed(() => {
  const { output } = points;
  if (!Array.isArray(output)) return [];
  return output.map(([x, y, d = distance.value, s = shift.value]) => {
    const A = inverseTriangulate({ x: radians(x), y: radians(y) }, d * 1000, s);
    return {
      l: A2V.L(A.l),
      r: A2V.R(A.r),
    };
  });
});

function interactOverride(flag: boolean = true) {
  if (flag) setpoint_select.value = null;
}

const is_drag = computed(() => cursor.value !== null);

watch(cursor, (c) => {
  if (c) {
    const { x, y } = c;
    target_loc.value = { x, y };
    interactOverride();
  }
});

const volt = reactive({
  L: { x: 0, y: 0 },
  R: { x: 0, y: 0 },
});

const actuate_task = abortable(async (_, onAbort) => {
  const c = controller.value;
  if (!c) return;
  const updated = new Latest<{ l: Point2d; r: Point2d }>();
  onAbort(() => updated.close());
  const handle = watch(target_volts, (t) => updated.push(t), {
    deep: true,
    immediate: true,
  });
  try {
    await c.enable();
    for await (const { l, r } of updated) {
      const { left, right } = await c.actuate({
        left: l,
        right: r,
      });
      volt.L = left;
      volt.R = right;
    }
  } finally {
    await c.disable();
    handle.stop();
  }
});

onUnmounted(async () => {
  await Promise.all([actuate_task.abort()]);
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

type Stack = Awaited<ReturnType<typeof stack>>;
function normalizeFovea({ image, format }: Stack, H: Mat<Float64Array>) {
  const bgra = makeBGRA(convertType(image, "16U"), format);
  return wrapPerspective(bgra, H);
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
  const fovea = {
    Q: matToArray(Q.value),
    baseline: baseline.value,
    "baseline.unit": "millimeter",
  };
  function numSetPoints() {
    return Array.isArray(points.output) ? points.output.length : 0;
  }
  if (setpoint.value === null || numSetPoints() === 0) {
    for await (const { name, ...content } of captureFoveaPair(sensor_size))
      provide(name, content);
  } else {
    for (let i = 0; i < numSetPoints(); i++) {
      setpoint_select.value = i;
      await delay(100);
      for await (const { name, ...content } of captureFoveaPair(sensor_size))
        provide(name, [content]);
    }
  }
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
          :cursor="{ ...target_loc, width, height, ...setpoint_pos }"
          :undistort="undistort"
          box="dot"
          :color="THEME.C"
        />
        <FrameCursor
          v-if="cursor && !is_drag"
          :cursor="{ ...cursor, ...setpoint_pos }"
          :undistort="undistort"
          color="#fffa"
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
            v-model="verge"
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
              <template v-else> ∞ </template>
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
            <span> {{ plusSign(shift.toFixed(4)) }}° </span>
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
              <template v-else> ∞ </template>
            </span>
          </RangeSlider>
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
              </select>
            </label>
          </ConfigEntry>
        </div>
      </template>
    </HorizontalDivision>
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
