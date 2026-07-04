<script setup lang="ts">
import {
  computed,
  markRaw,
  onUnmounted,
  ref,
  shallowReactive,
  shallowRef,
  watch,
} from "vue";
import { Camera } from "core/Aravis";
import {
  calibrateCamera,
  CameraCalibration,
  cornerSubPix,
  MarkerDetector,
  MarkerDetectResults,
  Mat,
  PreDefinedDictionary,
  Undistort,
} from "core/Vision";
import { Point2d, Point3d, Size } from "core/Geometry";
import StreamView from "@src/components/StreamView.vue";
import abortable from "@lib/abortable";
import { FreqMeter } from "@lib/util/perf";
import { delay } from "@lib/util";
import FrameView from "@src/components/FrameView.vue";
import { deg } from "@lib/util/math";
import { describeCamera, type CameraConfig } from "@lib/camera";
import NavBack from "@src/components/NavBack.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import CameraRole from "@src/components/CameraRole.vue";
import MarkerDetection from "@modules/calibrate-extrinsic/MarkerDetection.vue";
import {
  bilinearInterpolate,
  CORNER_OBJ_POINTS,
  getInternalObjectPoints,
} from "@lib/marker";
import { DictionaryTypeSelector } from "@modules/calibrate-intrinsic/dictionary-selector";
import rainbow from "@lib/swatch";

const props = defineProps<{
  camera: Camera;
  config: CameraConfig;
  calibration: Partial<CameraCalibration>;
  undistort?: Undistort | null;
}>();

const emit = defineEmits<{
  (e: "return"): void;
}>();

const { camera, calibration } = props;
const stream = markRaw(camera.stream);

const cursor = shallowRef<(Point2d & Size) | null>(null);

type Sample = {
  img_points: Point2d[];
  obj_points: Point3d[];
};

type Record = {
  rgba: Mat<Uint8Array>;
  gray: Mat<Uint8Array>;
  results: MarkerDetectResults;
  samples: Sample[];
};

const freq = new FreqMeter();
const scale = ref(4);
const dictionary = ref<PreDefinedDictionary>("4X4_50");
const detector = computed(() => new MarkerDetector(dictionary.value));
const sensor_size = shallowReactive<Size>({ width: 0, height: 0 });
const detection = shallowRef<MarkerDetectResults | null>(null);
const records = shallowReactive<Array<Record>>([]);

function clearRecords() {
  while (records.length > 0) records.pop();
}

function removeRecord(index: number) {
  records.splice(index, 1);
}

watch(sensor_size, (a, b) => {
  if (a.width !== b.width || a.height !== b.height) clearRecords();
});

watch(detection, (_, prev) => prev?.frame.release());

const task = computed(() => {
  const d = detector.value;
  const s = 1 / scale.value;
  if (!stream) return;
  const marker_stream = d.stream(stream, s);
  return abortable(async (aborted) => {
    for (const result of marker_stream) {
      if (aborted()) break;
      if (result === null) {
        await delay(1);
        continue;
      }
      freq.tick();
      sensor_size.width = result.frame.width;
      sensor_size.height = result.frame.height;
      detection.value = result;
    }
  });
});

watch(task, (_, prev) => prev?.abort());

async function capture() {
  const d = detection.value;
  if (!d) return;
  const frame = d.frame.ref();
  detection.value = null;
  const [gray, rgba] = await Promise.all([
    frame.view("Mono8"),
    frame.view("BGRA8"),
  ]);
  frame.release();
  const samples: Sample[] = [];
  for (const r of d) {
    const internal_obj_points = Array.from(
      getInternalObjectPoints(detector.value.pattern(r.id)),
    );
    const obj_points = [...CORNER_OBJ_POINTS, ...internal_obj_points];
    const img_points = [...r, ...bilinearInterpolate(r, internal_obj_points)];
    samples.push({ img_points, obj_points });
  }
  records.push({
    rgba,
    gray,
    results: d,
    samples,
  });
}

async function calibrate() {
  const samples = records
    .map((r) =>
      r.samples.map((s) => ({
        ...s,
        gray: r.gray,
      })),
    )
    .flat(1);
  const img_points = await Promise.all(
    samples.map((s) => cornerSubPix(s.gray, s.img_points)),
  );
  const obj_points = samples.map((s) => s.obj_points);
  const result = await calibrateCamera(sensor_size, img_points, obj_points);
  Object.assign(calibration, result, { date: new Date() });
  console.log("Calibration Result:", result);
}

onUnmounted(async () => {
  await task.value?.abort();
  clearRecords();
});
</script>

<template>
  <div class="view">
    <div class="left" style="flex-grow: 1; padding-top: 3em">
      <NavBack @back="emit('return')">
        <span>{{ describeCamera(camera) }}</span>
        <CameraRole v-if="config.role" :role="config.role" />
      </NavBack>
      <StreamView
        class="stream"
        :footnote="`Marker Detector @ ${freq}`"
        :camera="camera"
        height="min(60vh, 80vw)"
        v-model="cursor"
      >
        <MarkerDetection
          v-for="(d, i) in detection ?? []"
          :key="i"
          :detection="d"
          :color="rainbow(50).at(d.id)"
        />
      </StreamView>
      <ConfigEntry>
        <label>
          Marker Dictionary
          <DictionaryTypeSelector v-model="dictionary" />
        </label>
      </ConfigEntry>
      <ConfigEntry v-if="calibration.date">
        Calibrated At&nbsp;
        <span>{{ calibration.date.toLocaleString() }}</span>
      </ConfigEntry>
      <ConfigEntry v-if="undistort?.fov">
        FOV: X {{ deg(undistort.fov.x).toFixed(2) }}&deg;, Y
        {{ deg(undistort.fov.y).toFixed(2) }}&deg;
      </ConfigEntry>
    </div>
    <div class="right">
      <div class="records">
        <div
          v-for="(record, i) in records"
          class="record"
          :key="i"
          @click="removeRecord(i)"
        >
          <FrameView :mat="record.rgba" width="100%">
            <MarkerDetection
              v-for="(d, j) in record.results"
              :key="j"
              :detection="d"
              :features="record.samples[j].img_points"
              :color="rainbow(50).at(d.id)"
            />
          </FrameView>
        </div>
      </div>
      <h2>Captured Records ({{ records.length }})</h2>
      <div class="buttons">
        <button @click="capture" :disabled="!detection">Capture</button>
        <button @click="calibrate" :disabled="!records.length">
          Calibrate
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.view {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: row;
  .left,
  .right {
    display: flex;
    flex-direction: column;
  }
  .left {
    justify-content: center;
    align-items: center;
    background-color: #111;
  }
  .right {
    border-left: 2px solid #333;
    background-color: #222;
    width: max(30vw, 20ch);
    position: relative;
    box-sizing: border-box;
    .record {
      width: calc(50% - 0.55rem);
    }
    h2,
    .buttons,
    .records {
      position: absolute;
      left: 0;
      right: 0;
      padding: 0 1rem;
      margin: 0;
      background-color: #222a;
      box-sizing: border-box;
    }
    h2 {
      top: 0;
      height: 3rem;
      line-height: 3rem;
      font-size: 1.4rem;
    }
    .records {
      top: 0;
      bottom: 0;
      display: flex;
      flex-direction: row;
      overflow-y: scroll;
      flex-wrap: wrap;
      gap: 1rem;
      justify-content: flex-start;
      align-items: flex-start;
      align-content: flex-start;
      padding: 3rem 1rem;
    }
    .buttons {
      left: 0;
      right: 0;
      bottom: 0;
      height: 3rem;
      box-sizing: border-box;
      padding: 0 1rem;
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
  }
}
</style>
