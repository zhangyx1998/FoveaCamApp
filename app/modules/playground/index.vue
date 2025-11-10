<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import { MarkerDetector } from "core/Vision";
import { Point2d } from "core/Geometry";
import {
    ROLE,
    THEME,
    useCalibratedTriple,
    useCoordinateConversions,
} from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
import { getController } from "@src/components/Controller.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import Tracker from "@modules/calibrate-extrinsic/tracker";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import Marker from "@modules/calibrate-extrinsic/Marker.vue";
import abortable from "@lib/abortable";
import { AsyncChain } from "@lib/util/iter";
import { formatNumber, FormatNumberOptions } from "@lib/util";

const controller = computed(getController);
const triple = await useCalibratedTriple();
const { L, C, R } = triple;
const { A2V } = useCoordinateConversions(triple);
const detector = new MarkerDetector("4X4_50");
const tracker = {
    L: new Tracker(L, detector, 1, 0.25),
    C: new Tracker(C, detector, 0, 1.0),
    R: new Tracker(R, detector, 2, 0.25),
};

const u = triple.CI.undistort;
if (!u) throw new Error("Intrinsic calibration not found for center camera.");

const ctrl = controller.value;
if (!ctrl) throw new Error("MEMS Controller not found.");

const task = abortable(async (_, onAbort) => {
    const chain = new AsyncChain<Point2d>();
    onAbort(() => chain.close());
    const handle = watch(
        () => tracker.C.center_absolute,
        (c) => {
            if (c) chain.push(u.angular([c], true)[0]);
        }
    );
    try {
        await ctrl.enable();
        for await (const r of chain) {
            ctrl.actuate({
                left: A2V.L(r),
                right: A2V.R(r),
            });
        }
    } finally {
        handle.stop();
        chain.close();
        await ctrl.disable();
    }
});

function formatPos(pos?: Point2d) {
    if (!pos) return "X ---, Y ---";
    const { x, y } = pos;
    const options: FormatNumberOptions = {
        unit: "V",
        plusSign: true,
        decimals: 2,
        digitsBeforePoint: 3,
    };
    return `X ${formatNumber(x, options)}, Y ${formatNumber(y, options)}`;
}

onUnmounted(async () => {
    await Promise.all([
        task.abort(),
        tracker.L.task.abort(),
        tracker.C.task.abort(),
        tracker.R.task.abort(),
    ]);
    triple.release();
});
</script>

<template>
    <div class="cameras">
        <div class="view">
            <StreamView
                class="stream"
                :title="[ROLE.L, formatPos(controller?.pos.left)].join(' | ')"
                :footnote="`Marker Tracker @ ${tracker.L.fps ?? 'N/A'}`"
                :camera="L"
                :theme="THEME.L"
            >
                <Marker v-if="tracker.L.target" :detection="tracker.L.target" />
                <Marker
                    v-for="(d, i) in tracker.L.other_targets"
                    :key="i"
                    :detection="d"
                    color="gray"
                />
            </StreamView>
            <ConfigEntry>
                <span>
                    {{ tracker.L.target ? "✓" : "✗" }}
                    Marker ID to Track:
                </span>
                <input v-model.number="tracker.L.target_id" />
            </ConfigEntry>
        </div>
        <div class="view">
            <StreamView
                class="stream"
                :title="ROLE.C"
                :footnote="`Marker Tracker @ ${tracker.C.fps ?? 'N/A'}`"
                :camera="C"
                :theme="THEME.C"
            >
                <Marker v-if="tracker.C.target" :detection="tracker.C.target" />
                <Marker
                    v-for="(d, i) in tracker.C.other_targets"
                    :key="i"
                    :detection="d"
                    color="gray"
                />
                <FrameCursor
                    v-if="tracker.C.center_absolute"
                    :cursor="tracker.C.center_absolute"
                    :undistort="triple.CI.undistort"
                    box="rect"
                />
            </StreamView>
            <ConfigEntry>
                <span>
                    {{ tracker.C.target ? "✓" : "✗" }}
                    Marker ID to Track:
                </span>
                <input v-model.number="tracker.C.target_id" />
            </ConfigEntry>
        </div>
        <div class="view">
            <StreamView
                class="stream"
                :title="[ROLE.R, formatPos(controller?.pos.right)].join(' | ')"
                :footnote="`Marker Tracker @ ${tracker.R.fps ?? 'N/A'}`"
                :camera="R"
                :theme="THEME.R"
            >
                <Marker v-if="tracker.R.target" :detection="tracker.R.target" />
                <Marker
                    v-for="(d, i) in tracker.R.other_targets"
                    :key="i"
                    :detection="d"
                    color="gray"
                />
            </StreamView>
            <ConfigEntry>
                <span>
                    {{ tracker.R.target ? "✓" : "✗" }}
                    Marker ID to Track:
                </span>
                <input
                    v-model.number="tracker.R.target_id"
                    style="width: 2ch"
                />
            </ConfigEntry>
        </div>
    </div>
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

.actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 1rem;
    width: 100%;
    margin: 1em 0;
    & > * {
        display: block;
        width: 0;
        flex-grow: 1;
        height: 2rem;
    }
}
</style>
