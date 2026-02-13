<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from "vue";
import type { Undistort } from "core/Vision";
import type { Point2d, Rect } from "core/Geometry";
import { ExtrinsicRegression, MatchedCameras, ROLE, THEME } from "@lib/camera";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import { getController } from "@src/components/Controller.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import ConfigEntry from "@src/components/ConfigEntry.vue";
import abortable from "@lib/abortable";
import { Latest } from "@lib/util/iter";
import NavBack from "@src/components/NavBack.vue";

const controller = computed(getController);

const emit = defineEmits<{
    (e: "back"): void;
    (e: "confirm"): void;
}>();

const props = defineProps<{
    cameras: MatchedCameras<true>;
    undistort: Undistort;
    L: ExtrinsicRegression;
    R: ExtrinsicRegression;
    saved: boolean;
}>();

const cursor = shallowRef<(MouseEvent & Rect) | null>(null);
const zoom = ref(6.0);

watch(cursor, (c) => {
    console.log("cursor", c, c?.button);
    if (!c || !(c.buttons & 1)) return;
    const { undistort, L, R } = props;
    const [target] = undistort.angular([c], true);
    pos.L = L.V2A.predict(target);
    pos.R = R.V2A.predict(target);
});

const pos = reactive({
    L: { x: 0, y: 0 },
    R: { x: 0, y: 0 },
});

function projectBack(r: ExtrinsicRegression, p: Point2d) {
    const angle = r.A2V.predict(p);
    return props.undistort.position([angle], true)[0];
}

const task = abortable(async (aborted, onAbort) => {
    const c = controller.value;
    if (!c) return;
    const updated = new Latest<void>();
    onAbort(() => updated.close());
    const handle = watch(pos, () => updated.push(), { deep: true });
    try {
        await c.enable();
        for await (const _ of updated) {
            if (aborted()) break;
            await c.actuate({ left: pos.L, right: pos.R });
        }
    } finally {
        await c.disable();
        handle.stop();
    }
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
                :pos="pos.L"
                :lim="controller?.dv ?? 200"
                :color="THEME.L"
                style="width: 100%"
            />
        </div>
        <div class="view">
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
                    :cursor="projectBack(L, pos.L)"
                    :undistort="undistort"
                    box="dot"
                    :color="THEME.L"
                />
                <FrameCursor
                    :cursor="projectBack(R, pos.R)"
                    :undistort="undistort"
                    box="dot"
                    :color="THEME.R"
                />
            </StreamView>
            <ConfigEntry>
                <span>Zoom Ratio</span>
                <input type="number" v-model.number="zoom" />
            </ConfigEntry>
            <div class="actions">
                <button :disabled="true">Button</button>
            </div>
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
                :pos="pos.R"
                :lim="controller?.dv ?? 200"
                :color="THEME.R"
                style="width: 100%"
            />
        </div>
        <NavBack @click="emit('back')">
            <span>Back to Summarize</span>
            <div style="flex-grow: 1"></div>
            <button :disabled="saved" @click="emit('confirm')">
                Confirm and Save
            </button>
        </NavBack>
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
