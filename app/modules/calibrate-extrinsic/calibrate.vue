<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { MarkerDetector, Undistort } from "core/Vision";
import { MatchedCameras, ROLE, THEME } from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
import MarkerDetection from "./MarkerDetection.vue";
import PosView from "@src/components/PosView.vue";
import { getController, Pos } from "@src/components/Controller.vue";
import Tracker, { actuate } from "./tracker";
import FrameCursor from "@src/components/FrameCursor.vue";
import { ExtrinsicRecord } from "./calibrate";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import Line2D from "@src/components/Line2D.vue";
import RemoteCanvasTeleport from "@src/components/RemoteCanvasTeleport.vue";
import Marker from "@src/graphics/Marker.vue";
import CrossHair from "@src/graphics/CrossHair.vue";
import { useAppConfig } from "@lib/config";
import { Point2d } from "core/Geometry";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faTrashCan } from "@fortawesome/free-regular-svg-icons";

const emit = defineEmits<{
  (e: "finalize"): void;
}>();

const props = defineProps<{
  cameras: MatchedCameras<true>;
  undistort: Undistort;
  records: ExtrinsicRecord[];
}>();

const config = await useAppConfig();
const baseline_distance_mm = computed({
  get() {
    return config.baseline_distance_mm ?? 200.0;
  },
  set(v: number) {
    config.baseline_distance_mm = v;
  },
});

const marker_size_mm = computed({
  get() {
    return config.cal_marker_size_mm ?? 60.0;
  },
  set(v: number) {
    config.cal_marker_size_mm = v;
  },
});

const detector = new MarkerDetector("4X4_50");

const tracker = {
  L: props.cameras.L && new Tracker(props.cameras.L, detector, 1, 0.25, true),
  C: props.cameras.C && new Tracker(props.cameras.C, detector, 0, 1.0),
  R: props.cameras.R && new Tracker(props.cameras.R, detector, 2, 0.25, true),
};

const override: { left: Pos | null; right: Pos | null } = {
  left: null,
  right: null,
};

const controller = computed(getController);
const actuator = computed(
  () =>
    controller.value &&
    actuate(controller.value, tracker.L, tracker.R, {}, override),
);
watch(actuator, (_, prev) => prev?.abort());

const recordable = computed(() => {
  return (
    controller.value &&
    [tracker.L, tracker.C, tracker.R].every((t) => t?.target)
  );
});

async function capture() {
  if (!recordable.value) return;
  const { pos } = controller.value!;
  const { undistort } = props;
  props.records.push({
    L: {
      img_pts: tracker.L!.target!.img_pts,
      obj_pts: tracker.L!.target!.obj_pts,
      voltage: pos.left,
    },
    C: {
      img_pts: tracker.C!.target!.img_pts,
      obj_pts: tracker.C!.target!.obj_pts,
      angle: undistort.angular([tracker.C!.center_absolute!], true)[0],
    },
    R: {
      img_pts: tracker.R!.target!.img_pts,
      obj_pts: tracker.R!.target!.obj_pts,
      voltage: pos.right,
    },
  });
}

function clear() {
  props.records.splice(0, props.records.length);
}

onUnmounted(async () => {
  await Promise.all([
    tracker.L?.task.abort(),
    tracker.C?.task.abort(),
    tracker.R?.task.abort(),
    actuator.value?.abort(),
  ]);
});

const hover_record = ref<number | null>(null);
function printAngle({ x, y }: Point2d) {
  return `X ${x.toFixed(2)}°, Y ${y.toFixed(2)}°`;
}
</script>

<template>
  <div class="cameras">
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.L"
        :footnote="`Marker Tracker @ ${tracker.L?.fps ?? 'N/A'}`"
        :camera="cameras.L"
        :theme="THEME.L"
      >
        <MarkerDetection
          v-if="tracker.L?.target"
          :detection="tracker.L.target"
          :features="tracker.L.target.img_pts"
        />
        <MarkerDetection
          v-for="(d, i) in tracker.L?.other_targets"
          :key="i"
          :detection="d"
          color="gray"
        />
      </StreamView>
      <ConfigEntry v-if="tracker.L">
        <span>
          {{ tracker.L?.target ? "✓" : "✗" }}
          Marker ID to Track:
        </span>
        <input type="number" v-model.number="tracker.L.target_id" step="1" />
      </ConfigEntry>
      <PosView
        v-if="controller"
        :pos="controller.pos.left"
        :lim="controller.dv"
        :color="THEME.L"
        style="width: 100%"
        :font-size="12"
        @select="(p) => (override.left = p)"
      >
        <Line2D
          :data="[...records.map((r) => r.L.voltage), controller.pos.left]"
          :focus="hover_record"
          :focus-color="THEME.L"
        />
      </PosView>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.C"
        :footnote="`Marker Tracker @ ${tracker.C?.fps ?? 'N/A'}`"
        :camera="cameras.C"
        :theme="THEME.C"
      >
        <MarkerDetection
          v-if="tracker.C?.target"
          :detection="tracker.C.target"
        />
        <MarkerDetection
          v-for="(d, i) in tracker.C?.other_targets"
          :key="i"
          :detection="d"
          color="gray"
        />
        <FrameCursor
          v-if="tracker.C?.center_absolute"
          :cursor="tracker.C.center_absolute"
          :undistort="undistort"
          box="rect"
        />
      </StreamView>
      <ConfigEntry v-if="tracker.C">
        <span>
          {{ tracker.C?.target ? "✓" : "✗" }}
          Marker ID to Track:
        </span>
        <input type="number" v-model.number="tracker.C.target_id" step="1" />
      </ConfigEntry>
      <div class="actions">
        <button style="--color: #080" :disabled="!recordable" @click="capture">
          Capture
        </button>
        <button
          style="--color: #a00"
          :disabled="records.length === 0"
          @click="clear"
        >
          Clear
        </button>
        <button
          style="--color: #08a"
          :disabled="records.length === 0"
          @click="emit('finalize')"
        >
          Finalize
        </button>
      </div>
      <div class="records monospace">
        <div
          v-for="(r, i) in records"
          :key="i"
          @mouseenter="hover_record = i"
          @mouseleave="hover_record = null"
        >
          <div style="padding-left: 1ch">
            [{{ i + 1 }}] {{ printAngle(r.C.angle) }}
          </div>
          <button @click="records.splice(i, 1)">
            <Icon :icon="faTrashCan" />
          </button>
        </div>
      </div>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.R"
        :footnote="`Marker Tracker @ ${tracker.R?.fps ?? 'N/A'}`"
        :camera="cameras.R"
        :theme="THEME.R"
      >
        <MarkerDetection
          v-if="tracker.R?.target"
          :detection="tracker.R.target"
          :features="tracker.R.target.img_pts"
        />
        <MarkerDetection
          v-for="(d, i) in tracker.R?.other_targets"
          :key="i"
          :detection="d"
          color="gray"
        />
      </StreamView>
      <ConfigEntry v-if="tracker.R">
        <span>
          {{ tracker.R?.target ? "✓" : "✗" }}
          Marker ID to Track:
        </span>
        <input
          type="number"
          v-model.number="tracker.R.target_id"
          style="width: 2ch"
        />
      </ConfigEntry>
      <PosView
        v-if="controller"
        :pos="controller.pos.right"
        :lim="controller.dv"
        :color="THEME.R"
        style="width: 100%"
        :font-size="12"
        @select="(p) => (override.right = p)"
      >
        <Line2D
          :data="[...records.map((r) => r.R.voltage), controller.pos.right]"
          :focus="hover_record"
          :focus-color="THEME.R"
        />
      </PosView>
    </div>
  </div>
  <RemoteCanvasTeleport>
    <CrossHair
      :cx="baseline_distance_mm / 2 + marker_size_mm"
      :cy="marker_size_mm"
      weight="2"
    />
    <Marker
      :id="tracker.L.target_id"
      :size="marker_size_mm"
      :cx="-baseline_distance_mm / 2"
    />
    <Marker :id="tracker.C.target_id" :size="marker_size_mm" />
    <Marker
      :id="tracker.R.target_id"
      :size="marker_size_mm"
      :cx="baseline_distance_mm / 2"
    />
  </RemoteCanvasTeleport>
</template>

<style scoped lang="scss">
.cameras {
  display: flex;
  justify-content: space-evenly;
  flex-wrap: wrap;
  flex-direction: row;
  width: 100%;
  padding: 0.5em 0;
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
    background-color: var(--color, #888);
    border-radius: 0.2em;
    border: none;
    color: white;
    &:not(:disabled) {
      cursor: pointer;
      &:hover {
        filter: brightness(1.2);
      }
      &:active {
        filter: brightness(0.8);
      }
    }
    &:disabled {
      opacity: 0.5;
      filter: saturate(0.2);
      cursor: not-allowed;
    }
  }
}

.records {
  width: 100%;
  flex-grow: 1;
  overflow-y: scroll;
  margin: 0.5em 0;
  & > * {
    height: 3em;
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    &:hover {
      background-color: #fff1;
    }
    button {
      background: none;
      border: none;
      color: #f66;
      cursor: pointer;
      font-size: 1.2em;
      padding: 0.2em;
      height: 3em;
      width: 3em;
      &:hover {
        background-color: #fff1;
        color: #f00;
      }
    }
  }
  &,
  & > * {
    border-top: 1px solid #fff4;
    border-bottom: 1px solid #fff4;
  }
}
</style>
