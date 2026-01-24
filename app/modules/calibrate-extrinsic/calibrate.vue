<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import { MarkerDetector, Undistort } from "core/Vision";
import { MatchedCameras, ROLE, THEME } from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
import Marker from "./Marker.vue";
import PosView from "@src/components/PosView.vue";
import { getController } from "@src/components/Controller.vue";
import Tracker, { actuate } from "./tracker";
import FrameCursor from "@src/components/FrameCursor.vue";
import { ExtrinsicRecord } from "./calibrate";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import Line2D from "@src/components/Line2D.vue";

const emit = defineEmits<{
    (e: "finalize"): void;
}>();

const props = defineProps<{
    cameras: MatchedCameras<true>;
    undistort: Undistort;
    records: ExtrinsicRecord[];
}>();

const detector = new MarkerDetector("4X4_50");

const tracker = {
    L: props.cameras.L && new Tracker(props.cameras.L, detector, 1, 0.25, true),
    C: props.cameras.C && new Tracker(props.cameras.C, detector, 0, 1.0),
    R: props.cameras.R && new Tracker(props.cameras.R, detector, 2, 0.25, true),
};

const controller = computed(getController);
const actuator = computed(
    () => controller.value && actuate(controller.value, tracker.L, tracker.R)
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
    const [gl, gc, gr] = await Promise.all([
        tracker.L!.frame!.view("Mono8"),
        tracker.C!.frame!.view("Mono8"),
        tracker.R!.frame!.view("Mono8"),
    ]);
    const { undistort } = props;
    props.records.push({
        L: {
            img_pts: tracker.L!.target!.img_pts,
            obj_pts: tracker.L!.target!.obj_pts,
            frame: gl,
            voltage: pos.left,
        },
        C: {
            img_pts: tracker.C!.target!.img_pts,
            obj_pts: tracker.C!.target!.obj_pts,
            frame: gc,
            angle: undistort.angular([tracker.C!.center_absolute!], true)[0],
        },
        R: {
            img_pts: tracker.R!.target!.img_pts,
            obj_pts: tracker.R!.target!.obj_pts,
            frame: gr,
            voltage: pos.right,
        },
    });
}

onUnmounted(async () => {
    await Promise.all([
        tracker.L?.task.abort(),
        tracker.C?.task.abort(),
        tracker.R?.task.abort(),
        actuator.value?.abort(),
    ]);
});
</script>

<template>
    <div class="cameras">
        <div class="view">
            <StreamView class="stream" :title="ROLE.L" :footnote="`Marker Tracker @ ${tracker.L?.fps ?? 'N/A'}`"
                :camera="cameras.L" :theme="THEME.L">
                <Marker v-if="tracker.L?.target" :detection="tracker.L.target" :features="tracker.L.target.img_pts" />
                <Marker v-for="(d, i) in tracker.L?.other_targets" :key="i" :detection="d" color="gray" />
            </StreamView>
            <ConfigEntry v-if="tracker.L">
                <span>
                    {{ tracker.L?.target ? "✓" : "✗" }}
                    Marker ID to Track:
                </span>
                <input v-model.number="tracker.L.target_id" />
            </ConfigEntry>
            <PosView v-if="controller" :pos="controller.pos.left" :lim="controller.dv" :color="THEME.L"
                style="width: 100%">
                <Line2D :data="[
                    ...records.map((r) => r.L.voltage),
                    controller.pos.left,
                ]" marker="." />
            </PosView>
        </div>
        <div class="view">
            <StreamView class="stream" :title="ROLE.C" :footnote="`Marker Tracker @ ${tracker.C?.fps ?? 'N/A'}`"
                :camera="cameras.C" :theme="THEME.C">
                <Marker v-if="tracker.C?.target" :detection="tracker.C.target" />
                <Marker v-for="(d, i) in tracker.C?.other_targets" :key="i" :detection="d" color="gray" />
                <FrameCursor v-if="tracker.C?.center_absolute" :cursor="tracker.C.center_absolute"
                    :undistort="undistort" box="rect" />
            </StreamView>
            <ConfigEntry v-if="tracker.C">
                <span>
                    {{ tracker.C?.target ? "✓" : "✗" }}
                    Marker ID to Track:
                </span>
                <input v-model.number="tracker.C.target_id" />
            </ConfigEntry>
            <div class="actions">
                <button :disabled="!recordable" @click="capture">
                    Capture ({{ records.length }} records)
                </button>
                <button :disabled="records.length === 0" @click="emit('finalize')">
                    Finalize Calibration
                </button>
            </div>
        </div>
        <div class="view">
            <StreamView class="stream" :title="ROLE.R" :footnote="`Marker Tracker @ ${tracker.R?.fps ?? 'N/A'}`"
                :camera="cameras.R" :theme="THEME.R">
                <Marker v-if="tracker.R?.target" :detection="tracker.R.target" :features="tracker.R.target.img_pts" />
                <Marker v-for="(d, i) in tracker.R?.other_targets" :key="i" :detection="d" color="gray" />
            </StreamView>
            <ConfigEntry v-if="tracker.R">
                <span>
                    {{ tracker.R?.target ? "✓" : "✗" }}
                    Marker ID to Track:
                </span>
                <input v-model.number="tracker.R.target_id" style="width: 2ch" />
            </ConfigEntry>
            <PosView v-if="controller" :pos="controller.pos.right" :lim="controller.dv" :color="THEME.R"
                style="width: 100%">
                <Line2D :data="[
                    ...records.map((r) => r.R.voltage),
                    controller.pos.right,
                ]" marker="." />
            </PosView>
        </div>
    </div>
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

    &>* {
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

    &>* {
        display: block;
        width: 0;
        flex-grow: 1;
        height: 2rem;
    }
}
</style>
