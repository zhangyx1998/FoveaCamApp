<script setup lang="ts">
import {
    computed,
    markRaw,
    onUnmounted,
    reactive,
    ref,
    shallowRef,
    watch,
} from "vue";
import type { Point2d, Rect } from "core";
import {
    Regression,
    ROLE,
    THEME,
    useExtrinsicCalibration,
    useExtrinsicRegression,
    useIntrinsicCalibration,
    useMatchedCameras,
} from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import { getController } from "@src/components/Controller.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import abortable from "@lib/abortable";
import { Latest } from "@lib/util/iter";

const controller = computed(getController);
const cameras = await useMatchedCameras(true);
const undistort = (await useIntrinsicCalibration(cameras.C)).undistort.value!;
if (!undistort) {
    throw new Error("Intrinsic calibration not found for center camera.");
}

const [L, R] = await Promise.all([
    useExtrinsicCalibration(cameras.L).then(useExtrinsicRegression),
    useExtrinsicCalibration(cameras.R).then(useExtrinsicRegression),
]);

console.log("Regression L", L);
console.log("Regression R", R);

const cursor = shallowRef<(MouseEvent & Rect) | null>(null);
const target = reactive<Point2d>({ x: 0, y: 0 });
const rect = shallowRef<Rect | null>(null);
const zoom = ref(6.0);

watch(cursor, (c) => {
    if (c && isDrag(c.buttons)) {
        const { x, y, width, height } = c;
        const z = zoom.value;
        const w = width / z,
            h = height / z;
        Object.assign(target, { x, y });
        // rect.value = {
        //     x: x - w / 2,
        //     y: y - h / 2,
        //     width: w,
        //     height: h,
        // };
    }
});

const volt = reactive({
    L: { x: 0, y: 0 },
    R: { x: 0, y: 0 },
});

function projectBack(r: Regression, p: Point2d) {
    const angle: Point2d = {
        x: r.rx.predict(p),
        y: r.ry.predict(p),
    };
    const ret = undistort.position([angle], false)[0];
    console.log("Projecting back:", p, "to:", ret);
    return ret;
}

const L_back = computed(() => projectBack(L, volt.L));
const R_back = computed(() => projectBack(R, volt.R));

function isDrag(b?: number) {
    return b && b & 1;
}

const task = abortable(async (_, onAbort) => {
    const c = controller.value;
    if (!c) return;
    const updated = new Latest<Point2d>();
    onAbort(() => updated.close());
    const handle = watch(target, (t) => updated.push(t), {
        deep: true,
    });
    try {
        await c.enable();
        for await (const pos of updated) {
            const [target] = undistort.angular([pos], false);
            const { left, right } = await c.actuate({
                left: {
                    x: L.vx.predict(target),
                    y: L.vy.predict(target),
                },
                right: {
                    x: R.vx.predict(target),
                    y: R.vy.predict(target),
                },
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
    await task.abort();
    cameras.release();
});
</script>

<template>
    <div class="cameras">
        <div class="view">
            <StreamView
                class="stream"
                :title="ROLE.L"
                :camera="cameras.L"
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
            <StreamView
                class="stream"
                :title="ROLE.C + ' (Sliced View)'"
                :camera="cameras.C"
                :theme="THEME.C"
                :slice="rect"
            />
            <ConfigEntry>
                <span>Zoom Ratio</span>
                <input v-model.number="zoom" />
            </ConfigEntry>
            <div class="actions">
                <button :disabled="true">Button</button>
            </div>
            <StreamView
                class="stream"
                :title="ROLE.C"
                :camera="cameras.C"
                :theme="THEME.C"
                @mousedown="(e) => (cursor = e)"
                @mouseup="(e) => (cursor = e)"
                @mousemove="(e) => (cursor = e)"
                @mouseleave="() => (cursor = null)"
            >
                <FrameCursor
                    v-if="cursor"
                    :cursor="cursor"
                    :undistort="undistort"
                    box="dot"
                    color="gray"
                />
                <FrameCursor
                    :cursor="{ ...L_back, width: 1440, height: 1080 }"
                    :undistort="undistort"
                    box="dot"
                    :color="THEME.L"
                />
                <FrameCursor
                    :cursor="{ ...R_back, width: 1440, height: 1080 }"
                    :undistort="undistort"
                    box="dot"
                    :color="THEME.R"
                />
            </StreamView>
        </div>
        <div class="view">
            <StreamView
                class="stream"
                :title="ROLE.R"
                :camera="cameras.R"
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
        <slot></slot>
    </div>
</template>

<style scoped lang="scss">
.cameras {
    position: relative;
    display: flex;
    justify-content: space-evenly;
    flex-wrap: wrap;
    flex-direction: row;
    width: 100%;
    padding: 3.5em 0 0 0;
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
    }
}
</style>
