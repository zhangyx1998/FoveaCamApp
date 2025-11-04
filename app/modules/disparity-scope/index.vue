<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, shallowRef, watch } from "vue";
import { Mat, Vision, type Frame, type Point2d, type Rect } from "core";
import { getFrameSize, ROLE, THEME, useCalibratedTriple } from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import { getController } from "@src/components/Controller.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import abortable from "@lib/abortable";
import { Latest, Zip } from "@lib/util/iter";
import FrameView from "@src/components/FrameView.vue";
import { deg } from "@lib/util/math";

const view = ref<"disparity" | "sliced">("sliced");
const controller = computed(getController);
const { L, C, R, CI, LE, RE, config, A2V, V2A, P2A, A2P, release } =
    await useCalibratedTriple();
const { width, height } = await getFrameSize(C);
const undistort = CI.undistort!;
if (!undistort)
    throw new Error("Intrinsic calibration not found for center camera.");

const cursor = shallowRef<(MouseEvent & Rect) | null>(null);
const target = reactive<Rect>({ x: width / 2, y: height / 2, width, height });
const target_l = reactive<Point2d>({ x: 0, y: 0 });
const target_r = reactive<Point2d>({ x: 0, y: 0 });
const rect = computed(() => {
    const { x, y, width, height } = target;
    const z = zoom.value;
    const w = width / z;
    const h = height / z;
    Object.assign(target, { x, y, width, height });
    return {
        x: x - w / 2,
        y: y - h / 2,
        width: w,
        height: h,
    };
});

const zoom = computed<number>({
    get: () => config.zoom_factor ?? 9.0,
    set: (v) => (config.zoom_factor = v),
});

const is_drag = computed(
    () => cursor.value !== null && (cursor.value.buttons & 1) !== 0
);

watch(cursor, (c) => {
    if (c && is_drag.value) {
        const { x, y, width, height } = c;
        Object.assign(target, { x, y, width, height });
    }
});

const volt = reactive({
    L: { x: 0, y: 0 },
    R: { x: 0, y: 0 },
});

const L_PX = computed(() => A2P.C(V2A.L(volt.L)));
const R_PX = computed(() => A2P.C(V2A.R(volt.R)));

let delta_divergence: { l: number; r: number } | null = null;

const actuate_task = abortable(async (_, onAbort) => {
    const c = controller.value;
    if (!c) return;
    const updated = new Latest<Point2d>();
    onAbort(() => updated.close());
    const handle = watch(target, (t) => updated.push(t), {
        deep: true,
        immediate: true,
    });
    try {
        await c.enable();
        for await (const pos of updated) {
            const [r] = undistort.angular([pos], false);
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
const match_left = ref<Mat<Float32Array> | null>(null);
const match_right = ref<Mat<Float32Array> | null>(null);
function getLoc(m: Mat<Float32Array> | null) {
    if (!m) return null;
    const delta = (width - m.shape[1]) / 2;
    const loc = Vision.minMaxLoc(m).max;
    return loc.x + delta;
}
const loc_left = computed(() => getLoc(match_left.value));
const loc_right = computed(() => getLoc(match_right.value));

function getRectOfLoc(x: number, inset: number = 0) {
    const w = width / zoom.value;
    return {
        x: x - w / 2 + inset,
        y: inset,
        width: w - inset * 2,
        height: (guide.value?.shape[0] ?? 0) - inset * 2,
    };
}

function displayMatch(m: Mat<Float32Array> | null, v_stack = 10) {
    if (!m) return null;
    const l = Vision.minMaxLoc(m);
    const min = l.min.value;
    const max = l.max.value;
    const pad = Math.round((width - m.shape[1]) / 2);
    const u8 = new Uint8ClampedArray(width * 4);
    for (let i = 0; i < m.length; i++) {
        const v = Math.pow((m[i] - min) / (max - min), 3) * 255;
        const j = (i + pad) * 4;
        const R = v,
            B = 255 - v,
            G = Math.min(R, B);
        u8[j + 0] = R; // R
        u8[j + 1] = G; // G
        u8[j + 2] = B; // B
        u8[j + 3] = 255;
    }
    // V stack rows for better visibility.
    const ret = new Uint8Array(u8.length * v_stack) as Mat<Uint8Array>;
    for (let i = 0; i < v_stack; i++) ret.set(u8, i * u8.length);
    ret.shape = [v_stack, width];
    ret.channels = 4;
    return ret;
}

const divergence = computed(() => V2A.L(volt.L).x - V2A.R(volt.R).x);
const depth = computed(() => {
    const d = 0.2 / Math.sin(divergence.value);
    return Math.abs(d) < 1e8 ? d.toFixed(4) : "Infinity";
});
const divergenceReport = computed(() =>
    [
        "Divergence:",
        deg(divergence.value).toFixed(2),
        "degrees",
        "| Perceived Depth:",
        depth.value,
        "meters",
    ].join(" ")
);

const divergence_task = abortable(async (aborted) => {
    const zip = new Zip(L.stream, C.stream, R.stream);
    let l: Frame | null = null,
        c: Frame | null = null,
        r: Frame | null = null;
    async function getFoveaTile(f: Frame, h: number) {
        const m = await f.view("Mono8");
        // Make sure the tile size matches wide angle.
        return await Vision.resize(m, { height: h });
    }
    async function getMatchTile(f: Frame, h: number) {
        const y = target.y - h / 2;
        const m = await f.view("Mono8");
        return await Vision.slice(m, {
            x: 0,
            y,
            width: target.width,
            height: h,
        });
    }
    async function update(l: Frame, c: Frame, r: Frame) {
        const h = height / zoom.value;
        const [tl, tc, tr] = await Promise.all([
            getFoveaTile(l, h),
            getMatchTile(c, h),
            getFoveaTile(r, h),
        ]);
        guide.value = tc;
        [match_left.value, match_right.value] = await Promise.all([
            Vision.matchTemplate(tc, tl, "CCOEFF_NORMED"),
            Vision.matchTemplate(tc, tr, "CCOEFF_NORMED"),
        ]);
        // Update divergence
        if (is_drag.value) return;
        const ctrl = controller.value;
        if (!ctrl) return;
        const matched = {
            L: loc_left.value ?? target.x,
            C: target.x,
            R: loc_right.value ?? target.x,
        };
        const delta = {
            L: matched.C - matched.L,
            R: matched.C - matched.R,
        };
        console.log("Divergence delta (px):", delta);
        const { y } = target;
        const px_loc = {
            L: A2P.C(V2A.L(volt.L)).x,
            R: A2P.C(V2A.R(volt.R)).x,
        };
        const kp = 0.5;
        px_loc.L += delta.L * kp;
        px_loc.R += delta.R * kp;
        try {
            function fmt({ L, R }: { L: Point2d; R: Point2d }) {
                return {
                    L: `X ${L.x.toFixed(2)}, Y ${L.y.toFixed(2)}`,
                    R: `X ${R.x.toFixed(2)}, Y ${R.y.toFixed(2)}`,
                };
            }
            // Request might be rejected when user is dragging.
            const prev = fmt(volt);
            const target = fmt({
                L: A2V.L(P2A.C({ x: px_loc.L, y })),
                R: A2V.R(P2A.C({ x: px_loc.R, y })),
            });
            const { left, right } = await ctrl.actuate({
                left: A2V.L(P2A.C({ x: px_loc.L, y })),
                right: A2V.R(P2A.C({ x: px_loc.R, y })),
            });
            volt.L = { ...left };
            volt.R = { ...right };
            console.table({
                DELTA: delta,
                Prev: prev,
                Target: target,
                Actuated: fmt(volt),
            });
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
                await update(l, c, r);
                l.release();
                c.release();
                r.release();
                l = null;
                c = null;
                r = null;
            } else {
                await new Promise(requestAnimationFrame);
            }
            if (aborted()) return;
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

const disparity_frame = ref<Mat<Uint8Array> | null>(null);

const disparity_task = computed(() => {
    if (view.value !== "disparity") return null;
    return abortable(async (aborted) => {
        const zip = new Zip(L.stream, R.stream);
        let a: Frame | null = null,
            b: Frame | null = null;
        try {
            for (const [_a, _b] of zip) {
                if (aborted()) return;
                if (_a) {
                    a?.release();
                    a = _a;
                }
                if (_b) {
                    b?.release();
                    b = _b;
                }
                if (a && b) {
                    disparity_frame.value = await Vision.disparity(a, b, true);
                    a = null;
                    b = null;
                } else {
                    await new Promise(requestAnimationFrame);
                }
                if (aborted()) return;
            }
        } finally {
            a?.release();
            b?.release();
            disparity_frame.value = null;
        }
    });
});

watch(disparity_task, (_, prev) => prev?.abort());

onUnmounted(async () => {
    await Promise.all([
        actuate_task.abort(),
        divergence_task.abort(),
        disparity_task.value?.abort(),
    ]);
    release();
});
</script>

<template>
    <div class="cameras">
        <div class="view">
            <StreamView
                class="stream"
                :title="ROLE.L"
                :camera="L"
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
                v-if="view === 'sliced'"
                class="stream"
                :title="ROLE.C + ' (Sliced View)'"
                :camera="C"
                theme="white"
                :slice="rect"
            />
            <FrameView
                v-else-if="view === 'disparity'"
                class="stream"
                title="Left v.s. Right (Disparity)"
                :mat="disparity_frame"
                :theme="THEME.C"
            />
            <ConfigEntry>
                <label>
                    <span style="padding: 2ch">Zoom Ratio</span>
                    <input v-model.number="zoom" style="width: 4ch" />
                </label>
                <span>|</span>
                <label>
                    <span style="padding: 2ch">View Mode</span>
                    <select v-model="view">
                        <option value="sliced">Sliced</option>
                        <option value="disparity">Disparity</option>
                    </select>
                </label>
            </ConfigEntry>
            <!-- <div class="actions">
                <button :disabled="true">Button</button>
            </div> -->
            <StreamView
                class="stream"
                :title="ROLE.C"
                :camera="C"
                :theme="THEME.C"
                @mousedown="(e) => (cursor = e)"
                @mouseup="(e) => (cursor = e)"
                @mousemove="(e) => (cursor = e)"
                @mouseleave="() => (cursor = null)"
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
                <FrameCursor
                    v-if="cursor && !is_drag"
                    :cursor="cursor"
                    color="gray"
                />
            </StreamView>
        </div>
        <div class="view">
            <StreamView
                class="stream"
                :title="ROLE.R"
                :camera="R"
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
    <div class="divergence">
        <FrameView width="100%" :title="divergenceReport" :mat="guide">
            <template v-if="guide">
                <rect
                    v-bind="getRectOfLoc(target.x)"
                    :fill="THEME.C"
                    opacity="0.2"
                />
                <rect
                    v-if="loc_left"
                    v-bind="getRectOfLoc(loc_left, 2)"
                    fill="none"
                    :stroke="THEME.L"
                    stroke-width="2"
                    opacity="0.4"
                />
                <rect
                    v-if="loc_right"
                    v-bind="getRectOfLoc(loc_right, 2)"
                    fill="none"
                    :stroke="THEME.R"
                    stroke-width="2"
                    opacity="0.4"
                />
                <circle
                    :fill="THEME.C"
                    :cx="target.x"
                    :cy="(guide.shape[0] ?? 0) / 2"
                    r="3"
                />
                <circle
                    v-if="loc_left"
                    :fill="THEME.L"
                    :cx="loc_left"
                    :cy="(guide.shape[0] ?? 0) / 2"
                    r="3"
                />
                <circle
                    v-if="loc_right"
                    :fill="THEME.R"
                    :cx="loc_right"
                    :cy="(guide.shape[0] ?? 0) / 2"
                    r="3"
                />
            </template>
        </FrameView>
        <FrameView
            width="100%"
            :title="`Left Match ${loc_left}px (Red = Match, Blue = Mismatch)`"
            :mat="displayMatch(match_left)"
        >
        </FrameView>
        <FrameView
            width="100%"
            :title="`Right Match ${loc_right}px (Red = Match, Blue = Mismatch)`"
            :mat="displayMatch(match_right)"
            >CCOEFF_NORMED
        </FrameView>
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
</style>
