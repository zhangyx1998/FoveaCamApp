<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, shallowRef, watch } from "vue";
import { Point2d, Rect, Size } from "core/Geometry";
import {
    gaussian,
    heatmap,
    Mat,
    matchTemplate,
    minMaxLoc,
    resize,
    slice,
    disparity,
} from "core/Vision";
import { Frame } from "core/Aravis";
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
import ConfigEntry from "@src/components/ConfigEntry.vue";
import abortable from "@lib/abortable";
import { Latest, Zip } from "@lib/util/iter";
import FrameView from "@src/components/FrameView.vue";
import { deg } from "@lib/util/math";
import { VEC, RECT } from "@lib/util/geometry";
import { useAppConfig } from "@lib/config";
import { clamp } from "@lib/util";

const view = ref<"disparity" | "sliced">("sliced");
const app_config = await useAppConfig();
const kp = computed<number>({
    get: () => app_config.divergence_kp ?? 0.5,
    set: (v) => (app_config.divergence_kp = v),
});
const scale_ratio = computed<number>({
    get: () => app_config.divergence_template_match_scale ?? 0.0,
    set: (v) => (app_config.divergence_template_match_scale = v),
});
const controller = computed(getController);
const triple = await useCalibratedTriple();
const { L, C, R } = triple;
const { A2V, V2A, P2A, A2P } = useCoordinateConversions(triple);

const { width, height } = await getFrameSize(C);
const undistort = triple.CI.undistort;
if (!undistort)
    throw new Error("Intrinsic calibration not found for center camera.");

const cursor = shallowRef<(MouseEvent & Rect) | null>(null);
const target_loc = shallowRef<Point2d>({ x: width / 2, y: height / 2 });
const target_size = computed(() => ({
    width: width / zoom.value,
    height: height / zoom.value,
}));
const target = computed(() =>
    RECT.fromCenter(target_loc.value, target_size.value)
);

const zoom = computed<number>({
    get: () => Math.max(1.0, triple.config.zoom_factor ?? 9.0),
    set: (v) => (triple.config.zoom_factor = v),
});

const scale = computed(
    () => 1 + (zoom.value - 1) * clamp(scale_ratio.value, [0, 1])
);

const is_drag = computed(
    () => cursor.value !== null && (cursor.value.buttons & 1) !== 0
);

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

const L_PX = computed(() => A2P.C(V2A.L(volt.L)));
const R_PX = computed(() => A2P.C(V2A.R(volt.R)));

const actuate_task = abortable(async (_, onAbort) => {
    const c = controller.value;
    if (!c) return;
    const updated = new Latest<Point2d>();
    onAbort(() => updated.close());
    const handle = watch(target_loc, (t) => updated.push(t), {
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

type MatchResult = {
    mat: Mat<Uint8Array>;
    rect: Rect;
};

const match_left = shallowRef<MatchResult | null>(null);
const match_right = shallowRef<MatchResult | null>(null);
const match_center = shallowRef<{ rect: Rect } | null>(null);

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
    async function getFoveaTile(f: Frame, size: Size) {
        return await resize(await f.view("Mono8"), size);
    }
    async function getMatchTile(f: Frame, H: number, top: number, s: number) {
        const m = await f.view("Mono8");
        const roi: Rect = {
            x: 0,
            y: top,
            width,
            height: H,
        };
        const sliced = slice(m, roi);
        const scaled = await resize(sliced, {}, s, s);
        return scaled;
    }
    async function processMatch(
        match: Mat<Float32Array>,
        needle: Mat,
        s: number
    ): Promise<MatchResult> {
        const loc = minMaxLoc(match).max;
        const [height = 0, width = 0] = needle.shape;
        const rect = RECT.fromTopLeft(loc, { width, height });
        const [h1 = 0, w1 = 0] = match.shape;
        const [h2 = 0, w2 = 0] = needle.shape;
        const sliced = slice(match, {
            x: -w2 / 2,
            y: 0,
            width: w1 + w2 * 2,
            height: h1,
        });
        const resized = await resize(sliced, {}, s);
        return {
            mat: heatmap(resized),
            rect: VEC.mul(rect, s),
        };
    }
    async function update(l: Frame, c: Frame, r: Frame) {
        const z = zoom.value; // Zoom ratio = FOV(wide) / FOV(fovea)
        const s = scale.value; // Scale of fovea tiles (1.0 ~ zoom)
        const h = (height * s) / z; // Height of fovea tile (scaled)
        const w = (width * s) / z; // Width of fovea tile (scaled)
        const H = (height / z) * 2;
        const t = { ...target_loc.value }; // Center of target in pixels
        const top = t.y - H / 2;
        const [tl, tc, tr] = await Promise.all([
            getFoveaTile(l, { width: w, height: h }),
            getMatchTile(c, H, top, s),
            getFoveaTile(r, { width: w, height: h }),
        ]);
        guide.value = await resize(tc, {}, 1 / s);
        const [ml, mr] = ([match_left.value, match_right.value] =
            await Promise.all([
                matchTemplate(tc, tl, "CCOEFF_NORMED").then((m) =>
                    processMatch(gaussian(m, 9, 10), tl, 1 / s)
                ),
                matchTemplate(tc, tr, "CCOEFF_NORMED").then((m) =>
                    processMatch(gaussian(m, 9, 10), tr, 1 / s)
                ),
            ]));
        const mc = (match_center.value = {
            rect: RECT.fromCenter(VEC.sub(t, { y: top }), {
                width: w / s,
                height: h / s,
            }),
        });
        // Update divergence
        if (is_drag.value) return;
        const ctrl = controller.value;
        if (!ctrl) return;
        // Center pixel location on match guide strip
        const matched = {
            L: RECT.getCenter(ml.rect),
            C: RECT.getCenter(mc.rect),
            R: RECT.getCenter(mr.rect),
        };
        // Delta pixel location relative to target center
        const delta = {
            L: VEC.sub(matched.C, matched.L),
            R: VEC.sub(matched.C, matched.R),
        };
        // Current center pixel location of fovea cameras on wide angle frame
        const px_loc = {
            L: A2P.C(V2A.L(volt.L)),
            R: A2P.C(V2A.R(volt.R)),
        };
        // Step towards reducing the divergence
        px_loc.L = VEC.add(px_loc.L, VEC.mul(delta.L, kp.value));
        px_loc.R = VEC.add(px_loc.R, VEC.mul(delta.R, kp.value));
        // Request might be rejected when user is dragging.
        try {
            const { left, right } = await ctrl.actuate({
                left: A2V.L(P2A.C(px_loc.L)),
                right: A2V.R(P2A.C(px_loc.R)),
            });
            volt.L = { ...left };
            volt.R = { ...right };
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
                    disparity_frame.value = await disparity(a, b, true);
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

function circleCenter({ x, y }: Point2d) {
    return { cx: x, cy: y };
}

watch(disparity_task, (_, prev) => prev?.abort());

onUnmounted(async () => {
    await Promise.all([
        actuate_task.abort(),
        divergence_task.abort(),
        disparity_task.value?.abort(),
    ]);
    triple.release();
});
</script>

<template>
    <div class="cameras">
        <div class="view">
            <StreamView class="stream" :title="ROLE.L" :camera="L" :theme="THEME.L">
            </StreamView>
            <PosView :pos="volt.L" :lim="controller?.dv ?? 200" :color="THEME.L" style="width: 100%" />
        </div>
        <div class="view">
            <StreamView v-if="view === 'sliced'" class="stream" :title="ROLE.C + ' (Sliced View)'" :camera="C"
                theme="white" :slice="target" />
            <FrameView v-else-if="view === 'disparity'" class="stream" title="Left v.s. Right (Disparity)"
                :mat="disparity_frame" :theme="THEME.C" />
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
            <StreamView class="stream" :title="ROLE.C" :camera="C" :theme="THEME.C" @mousedown="(e) => (cursor = e)"
                @mouseup="(e) => (cursor = e)" @mousemove="(e) => (cursor = e)" @mouseleave="() => (cursor = null)">
                <FrameCursor :cursor="target" :undistort="undistort" box="dot" :color="THEME.C" />
                <FrameCursor box="rect" :cursor="{ ...L_PX, width, height }" :color="THEME.L" />
                <FrameCursor box="rect" :cursor="{ ...R_PX, width, height }" :color="THEME.R" />
                <FrameCursor v-if="cursor && !is_drag" :cursor="cursor" color="gray" />
            </StreamView>
        </div>
        <div class="view">
            <StreamView class="stream" :title="ROLE.R" :camera="R" :theme="THEME.R">
            </StreamView>
            <PosView :pos="volt.R" :lim="controller?.dv ?? 200" :color="THEME.R" style="width: 100%" />
        </div>
    </div>
    <div class="divergence">
        <FrameView width="100%" :title="divergenceReport" :mat="guide">
            <template v-if="guide">
                <rect v-if="match_center" v-bind="RECT(match_center.rect)" :fill="THEME.C" opacity="0.2" />
                <rect v-if="match_left" v-bind="RECT.offset(match_left.rect, -2)" fill="none" :stroke="THEME.L"
                    stroke-width="2" opacity="0.4" />
                <rect v-if="match_right" v-bind="RECT.offset(match_right.rect, -2)" fill="none" :stroke="THEME.R"
                    stroke-width="2" opacity="0.4" />
                <circle :fill="THEME.C" :cx="target_loc.x" :cy="(guide.shape[0] ?? 0) / 2" r="3" />
                <circle v-if="match_left" :fill="THEME.L" v-bind="circleCenter(RECT.getCenter(match_left.rect))"
                    r="3" />
                <circle v-if="match_right" :fill="THEME.R" v-bind="circleCenter(RECT.getCenter(match_right.rect))"
                    r="3" />
            </template>
        </FrameView>
        <FrameView width="100%" :title="`Left Match ${(match_left && RECT.getCenter(match_left.rect).x) || '--'
            }px (Red = Match, Blue = Mismatch)`" :mat="match_left?.mat">
        </FrameView>
        <FrameView width="100%" :title="`Right Match ${(match_right && RECT.getCenter(match_right.rect).x) || '--'
            }px (Red = Match, Blue = Mismatch)`" :mat="match_right?.mat">
        </FrameView>
        <fieldset>
            <legend>Control Parameters</legend>
            <label>
                kp
                <input type="range" min="0.1" max="1.0" step="0.01" v-model.number="kp" />
                {{ kp }}
            </label>
            <label>
                scale
                <input type="range" min="0.0" max="1.0" step="0.01" v-model.number="scale_ratio" />
                {{ scale.toFixed(2) }}
            </label>
        </fieldset>
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

    &>* {
        display: block;
        width: 0;
        flex-grow: 1;
        height: 2rem;
    }
}
</style>
