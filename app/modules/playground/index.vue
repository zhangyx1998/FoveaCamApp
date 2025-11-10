<script setup lang="ts">
import { computed, onUnmounted, shallowRef, watch } from "vue";
import {
    cornerSubPix,
    findHomography,
    MarkerDetector,
    MarkerDetectResult,
    Mat,
    wrapPerspective,
} from "core/Vision";
import { area, Point2d } from "core/Geometry";
import {
    ROLE,
    THEME,
    useCalibratedTriple,
    useCoordinateConversions,
} from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
import { getController } from "@src/components/Controller.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import Tracker, { TrackerTarget } from "@modules/calibrate-extrinsic/tracker";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import Marker from "@modules/calibrate-extrinsic/Marker.vue";
import abortable from "@lib/abortable";
import { AsyncChain } from "@lib/util/iter";
import { delay, formatNumber, FormatNumberOptions } from "@lib/util";
import { Camera } from "core/Aravis";
import {
    bilinearInterpolate,
    CORNER_OBJ_POINTS,
    getInternalObjectPoints,
} from "@lib/marker";
import FrameView from "@src/components/FrameView.vue";

const controller = computed(getController);
const triple = await useCalibratedTriple();
const { L, C, R } = triple;
const { A2V } = useCoordinateConversions(triple);
const detector = new MarkerDetector("4X4_50");
const tracker = {
    L: new Tracker(L, detector, 1, 0.25, true),
    C: new Tracker(C, detector, 0, 1.0),
    R: new Tracker(R, detector, 2, 0.25, true),
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

function getDstPts(pts: Point2d[], center: Point2d, scale: number) {
    return pts.map(({ x, y }) => ({
        x: center.x + x * scale,
        y: center.y + y * scale,
    }));
}

type Projection = {
    H: Mat<Float64Array>;
    rgba: Mat<Uint8Array>;
    target: TrackerTarget;
};

const prj_l = shallowRef<Projection | null>(null);
const prj_r = shallowRef<Projection | null>(null);

function createProjectionTask(
    camera: Camera,
    tracker: Tracker,
    prj: typeof prj_l | typeof prj_r
) {
    return abortable(async (aborted) => {
        for (const frame of camera.stream) {
            if (aborted()) {
                frame?.release();
                break;
            }
            if (!frame || !tracker.target) {
                frame?.release();
                await delay(1);
                continue;
            }
            const [gray, rgba] = await Promise.all([
                frame.view("Mono8"),
                frame.view("BGRA8"),
            ]);
            frame.release();
            const { target } = tracker;
            const s = Math.sqrt(area(target));
            const c = tracker.center_absolute!;
            const dst_corners = getDstPts(CORNER_OBJ_POINTS, c, s);
            const dst_img_pts = bilinearInterpolate(
                dst_corners,
                target.obj_pts
            );
            const dst: TrackerTarget = Object.assign(dst_corners, {
                id: target.id,
                width: target.width,
                height: target.height,
                img_pts: dst_img_pts,
                obj_pts: target.obj_pts,
            });
            const H = await findHomography(target.img_pts, dst_img_pts);
            const P = await wrapPerspective(rgba, H);
            prj.value = {
                H,
                rgba: P,
                target: dst,
            };
            await new Promise(requestAnimationFrame);
        }
    });
}

const prj_task_l = createProjectionTask(L, tracker.L, prj_l);
const prj_task_r = createProjectionTask(R, tracker.R, prj_r);

onUnmounted(async () => {
    await Promise.all([
        task.abort(),
        tracker.L.task.abort(),
        tracker.C.task.abort(),
        tracker.R.task.abort(),
        prj_task_l.abort(),
        prj_task_r.abort(),
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
                <Marker
                    v-if="tracker.L.target"
                    :detection="tracker.L.target"
                    :features="tracker.L.target.img_pts"
                />
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
            <FrameView
                class="stream"
                title="Homography Projection"
                :mat="prj_l?.rgba"
                :theme="THEME.L"
            >
                <Marker
                    v-if="prj_l?.target"
                    :detection="prj_l.target"
                    :features="prj_l.target.img_pts"
                />
            </FrameView>
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
                <Marker
                    v-if="tracker.R.target"
                    :detection="tracker.R.target"
                    :features="tracker.R.target.img_pts"
                />
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
            <FrameView
                class="stream"
                title="Homography Projection"
                :mat="prj_r?.rgba"
                :theme="THEME.R"
            >
                <Marker
                    v-if="prj_r?.target"
                    :detection="prj_r.target"
                    :features="prj_r.target.img_pts"
                />
            </FrameView>
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
