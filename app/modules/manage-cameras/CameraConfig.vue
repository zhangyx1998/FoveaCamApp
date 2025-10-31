<script setup lang="ts">
import { markRaw, customRef, onUnmounted, computed } from "vue";
import type { Camera } from "core";
import StreamView from "@src/components/StreamView.vue";
import {
    describeCamera,
    useCameraConfig,
    initCamera,
    getCameraInfo,
} from "@lib/camera";
import Store from "@lib/store";

const { camera } = defineProps<{ camera: Camera }>();
const store = await useCameraConfig(camera);
initCamera(camera, store);

let timeout_handle: ReturnType<typeof setInterval> | null = null;

const config = customRef<Camera>((track, trigger) => {
    const proxy = new Proxy(
        {},
        {
            get(_, prop) {
                track();
                return (camera as any)[prop];
            },
            set(_, prop, value) {
                const prev = (camera as any)[prop];
                try {
                    if (typeof value !== typeof prev) value = JSON.parse(value);
                    if (typeof value !== typeof prev)
                        throw new TypeError(
                            `Type mismatch: expected ${typeof prev}, got ${typeof value}`
                        );
                    (camera as any)[prop] = value;
                    (store as any)[prop] = value;
                    return true;
                } catch (e) {
                    console.error(
                        `Failed to set ${prop.toString()} to ${value}:`,
                        e
                    );
                    return false;
                } finally {
                    trigger();
                }
            },
        }
    );
    timeout_handle = setInterval(trigger, 1000);
    return {
        get() {
            return proxy as Camera;
        },
        set(_) {
            throw new Error("Setting readonly camera config.");
        },
    };
});

onUnmounted(() => {
    if (timeout_handle !== null) clearInterval(timeout_handle);
});

const autoMode = ["Off", "Once", "Continuous"];
const autoModeText: Record<string, string> = {
    Off: "Manual",
    Once: "Auto (once)",
    Continuous: "Auto (cont.)",
};

// log10(us)
function logExp(us: number) {
    return Math.log10(us);
}
logExp.inverse = (v: number) => Math.pow(10, v);

const log_exposure = computed({
    get() {
        return logExp(config.value.exposure);
    },
    set(val: number) {
        val = logExp.inverse(val);
        config.value.exposure = Math.round(val / 100) * 100;
    },
});

function reset() {
    camera.frame_rate_enable = false;
    camera.exposure_auto = "Once";
    camera.gain_auto = "Once";
    if (camera.black_level_auto_available) camera.black_level_auto = "Once";
    Store.clear(store);
}
</script>

<template>
    <div class="view">
        <StreamView
            class="stream"
            :title="describeCamera(camera)"
            :stream="markRaw(camera.stream)"
            :overlay="getCameraInfo(camera)"
            width="100%"
            theme="white"
        />
        <fieldset>
            <legend>Role Assignment</legend>
            <select v-model="store.role">
                <option :value="undefined">[ NONE ]</option>
                <option value="L">Fovea Left</option>
                <option value="C">Wide Angle</option>
                <option value="R">Fovea Right</option>
            </select>
        </fieldset>
        <fieldset v-if="config.frame_rate_available">
            <legend>
                Frame Rate
                <select v-model="config.frame_rate_enable">
                    <option
                        :value="true"
                        :selected="config.frame_rate_enable === true"
                    >
                        Manual
                    </option>
                    <option
                        :value="false"
                        :selected="config.frame_rate_enable === false"
                    >
                        Auto
                    </option>
                </select>
            </legend>
            <label>
                <input
                    type="range"
                    v-model="config.frame_rate"
                    :min="config.frame_rate_range.min"
                    :max="config.frame_rate_range.max"
                    :disabled="!config.frame_rate_enable"
                />
                {{ config.frame_rate.toFixed(2) }} FPS
            </label>
        </fieldset>
        <fieldset v-if="config.exposure_auto_available">
            <legend>
                Exposure
                <select v-model="config.exposure_auto">
                    <option
                        v-for="mode in autoMode"
                        :value="mode"
                        :selected="mode === config.exposure_auto"
                    >
                        {{ autoModeText[mode] }}
                    </option>
                </select>
            </legend>
            <label>
                <input
                    type="range"
                    v-model="log_exposure"
                    :min="logExp(config.exposure_range.min)"
                    :max="logExp(config.exposure_range.max)"
                    step="0.001"
                    :disabled="config.exposure_auto !== 'Off'"
                />
                {{ (config.exposure / 1000.0).toFixed(2) }} ms
            </label>
        </fieldset>
        <fieldset v-if="config.gain_auto_available">
            <legend>
                Gain
                <select v-model="config.gain_auto">
                    <option
                        v-for="mode in autoMode"
                        :value="mode"
                        :selected="mode === config.gain_auto"
                    >
                        {{ autoModeText[mode] }}
                    </option>
                </select>
            </legend>
            <label>
                <input
                    type="range"
                    v-model="config.gain"
                    :min="config.gain_range.min"
                    :max="config.gain_range.max"
                    step="0.001"
                    :disabled="config.gain_auto !== 'Off'"
                />
                {{ config.gain.toFixed(2) }} dB
            </label>
        </fieldset>
        <fieldset v-if="config.black_level_available">
            <legend>
                Black Level
                <select v-model="config.black_level_auto">
                    <option
                        v-for="mode in autoMode"
                        :value="mode"
                        :selected="mode === config.black_level_auto"
                    >
                        {{ autoModeText[mode] }}
                    </option>
                </select>
            </legend>
            <label>
                <input
                    type="range"
                    v-model="config.black_level"
                    :min="config.black_level_range.min"
                    :max="config.black_level_range.max"
                    step="0.001"
                    :disabled="config.black_level_auto !== 'Off'"
                />
                {{ config.black_level.toFixed(2) }} dB
            </label>
        </fieldset>
        <div>
            <button @click="reset">Reset Config</button>
        </div>
    </div>
</template>

<style scoped lang="scss">
.view {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    gap: 1em;
}

fieldset {
    border-radius: 1em;
    border-width: 1px;
    border-color: #fff8;
    &:focus,
    &:focus-within {
        border-color: #08c;
    }
    legend {
        padding: 0 1ch;
    }
    padding: 0.6em 1ch;
}

input[type="range"] {
    width: 100%;
}

select {
    font-family: inherit;
    font-size: inherit;
    outline: 1px solid #666;
    border: none;
    background: none;
    border-radius: 4px;
    padding: 0.2em 1ch;
    color: inherit;
    &:focus {
        outline: 1px solid #08c;
    }
}
</style>
