<script setup lang="ts">
import { customRef, onUnmounted, computed, ref, nextTick } from "vue";
import type { Camera } from "core/Aravis";
import StreamView from "@src/components/StreamView.vue";
import { describeCamera, useCameraConfig, initCamera } from "@lib/camera";
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

// Pixel format is locked by the camera while acquisition is active, so it
// cannot be changed live. Unmounting the preview drops the only stream
// subscriber, which makes the native stream thread stop acquisition; we then
// set the format (retrying to absorb the cross-thread stop) and remount so the
// preview resubscribes and restarts acquisition with the new payload size.
const streamActive = ref(true);
const pixelFormatBusy = ref(false);

async function changePixelFormat(fmt: string) {
    if (pixelFormatBusy.value || fmt === camera.pixel_format) return;
    pixelFormatBusy.value = true;
    streamActive.value = false;
    try {
        await nextTick();
        let lastErr: unknown = null;
        for (let i = 0; i < 30; i++) {
            try {
                camera.pixel_format = fmt as typeof camera.pixel_format;
                (store as any).pixel_format = fmt;
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        if (lastErr) console.error("Failed to set pixel format:", lastErr);
    } finally {
        streamActive.value = true;
        pixelFormatBusy.value = false;
    }
}

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
            v-if="streamActive"
            class="stream"
            :title="describeCamera(camera)"
            :camera="camera"
            width="100%"
            theme="white"
        />
        <div v-else class="stream stream-paused">
            Switching pixel format…
        </div>
        <fieldset>
            <legend>Role Assignment</legend>
            <select v-model="store.role">
                <option :value="undefined">[ NONE ]</option>
                <option value="L">Fovea Left</option>
                <option value="C">Wide Angle</option>
                <option value="R">Fovea Right</option>
            </select>
        </fieldset>
        <fieldset v-if="config.pixel_format_options?.length">
            <legend>Pixel Format</legend>
            <select
                :value="config.pixel_format"
                :disabled="pixelFormatBusy"
                @change="
                    changePixelFormat(
                        ($event.target as HTMLSelectElement).value
                    )
                "
            >
                <option
                    v-for="fmt in config.pixel_format_options"
                    :value="fmt"
                    :selected="fmt === config.pixel_format"
                >
                    {{ fmt }}
                </option>
            </select>
            <p class="hint">
                Changing format briefly pauses the preview to reconfigure the
                camera. 12-bit packed formats (e.g. BayerRG12p) read full sensor
                depth to cut debayer quantization noise.
            </p>
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

.hint {
    margin: 0.5em 0 0;
    font-size: 0.8em;
    opacity: 0.6;
}

.stream-paused {
    display: flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 16 / 9;
    border-radius: 0.5em;
    background: #0004;
    opacity: 0.7;
}
</style>
