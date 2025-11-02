<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<script lang="ts">
import { Protocol, type LogLevel, type PacketFactory } from "core";
import { SerialPort } from "serialport";
import type { PortInfo } from "@serialport/bindings-interface";
import { clamp } from "../../lib/util";
import { computed, ref, shallowRef, useTemplateRef } from "vue";
import { ElementSize } from "@lib/util/dom";
import { setAction } from "./Loading.vue";

export type Pos = { x: number; y: number };

function volt2dac(volt: number) {
    return clamp((65535 * volt) / 200, [0, 65535]) | 0;
}

function dac2volt(ch: number) {
    return (200 * ch) / 65535;
}

function ch(volt: number, bias: number, dv: number): [number, number] {
    const v = clamp(volt / 2, [-dv, dv]);
    return [volt2dac(bias + v), volt2dac(bias - v)];
}

function channels(
    pos: Pos,
    bias: number,
    dv: number
): [number, number, number, number] {
    const { x, y } = pos;
    return [...ch(x, bias, dv / 2), ...ch(y, bias, dv / 2)];
}

const origin: { left: Pos; right: Pos } = {
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
};

export class Controller {
    private static readonly __singleton__ = shallowRef<Controller | null>(null);
    static get singleton() {
        return this.__singleton__.value;
    }
    static set singleton(v: Controller | null) {
        this.__singleton__.value = v;
    }
    private static readonly __pending__ = ref<boolean>(false);
    static get pending() {
        return this.__pending__.value;
    }
    static set pending(v: boolean) {
        this.__pending__.value = v;
    }
    static async match(match: Partial<PortInfo>) {
        search_loop: for (const info of await SerialPort.list()) {
            for (const [k, v] of Object.entries(match))
                if (info[k as keyof PortInfo] !== v) continue search_loop;
            return info;
        }
    }
    private readonly protocol: Protocol;
    public readonly ready: Promise<void>;
    public readonly release: () => void;
    constructor(
        info: PortInfo,
        public readonly dv: number = 170.0,
        bias: number = 90.0,
        lpf: number = 120,
        log_level: LogLevel = "INFO"
    ) {
        this.protocol = new Protocol(info.path);
        this.release = () => this.protocol.release();
        this.ready = (async () => {
            await this.disable();
            console.log("Controller connected:", info);
            console.log("  Info:", await this.info);
            console.log("  Version:", await this.version);
            console.log("  Bias Voltage:", await this.setBias(bias));
            console.log("  LPF Frequency:", await this.setLPF(lpf));
            console.log("  Log Level:", await this.setLogLevel(log_level));
        })();
    }
    private get<T>(prop: PacketFactory<T>) {
        if (!this.protocol.connected)
            throw new Error("Controller not connected");
        return this.protocol.get(prop);
    }
    private set<T>(prop: PacketFactory<T>, arg: T | BufferLike) {
        if (!this.protocol.connected)
            throw new Error("Controller not connected");
        return this.protocol.set(prop, arg);
    }
    // Application-level API
    get info() {
        return this.get(Protocol.System.Info);
    }
    get version() {
        return this.get(Protocol.System.Version);
    }
    private readonly __enabled__ = ref<boolean>(false);
    get enabled() {
        return this.__enabled__.value;
    }
    enable() {
        return this.set(Protocol.System.Enable, true).then((v) => {
            this.__enabled__.value = true;
            return v;
        });
    }
    disable() {
        this.__pos__.value = origin;
        return this.set(Protocol.System.Enable, false).then((v) => {
            this.__enabled__.value = false;
            return v;
        });
    }
    getLogLevel() {
        return this.get(Protocol.Config.Log);
    }
    setLogLevel(level: LogLevel) {
        return this.set(Protocol.Config.Log, level);
    }
    getLPF() {
        return this.get(Protocol.Config.LPF);
    }
    setLPF(value: number) {
        return this.set(Protocol.Config.LPF, value);
    }

    private bias: number = 0;
    async getBias() {
        const bias = await this.get(Protocol.Config.Bias);
        this.bias = dac2volt(Number(bias));
        return this.bias;
    }
    async setBias(value: number) {
        const bias = await this.set(Protocol.Config.Bias, volt2dac(value));
        this.bias = dac2volt(Number(bias));
        return this.bias;
    }
    private readonly __pos__ = shallowRef<{ left: Pos; right: Pos }>(origin);
    get pos() {
        return this.__pos__.value;
    }
    async actuate(pos: { left?: Pos; right?: Pos }, settle_time = 0) {
        const { left, right, complete_time } = await this.set(
            Protocol.Command.Actuate,
            {
                left: channels(pos.left ?? this.pos.left, this.bias, this.dv),
                right: channels(
                    pos.right ?? this.pos.right,
                    this.bias,
                    this.dv
                ),
                settle_time,
            }
        );
        const new_pos = {
            left: {
                x: dac2volt(left[0] - left[1]),
                y: dac2volt(left[2] - left[3]),
            },
            right: {
                x: dac2volt(right[0] - right[1]),
                y: dac2volt(right[2] - right[3]),
            },
        };
        this.__pos__.value = new_pos;
        return { ...new_pos, complete_time };
    }
    trigger(duration_ns: number) {
        return this.set(Protocol.Command.Trigger, duration_ns);
    }
}

export function getController() {
    return Controller.singleton;
}

const vendorId = ref("16c0");
const productId = ref("0483");

export async function connect() {
    setAction("Connecting to Controller...");
    if (Controller.pending) throw new Error("Controller is pending");
    Controller.pending = true;
    try {
        const info = await Controller.match({
            vendorId: vendorId.value,
            productId: productId.value,
        });
        const mems = info ? new Controller(info) : null;
        if (mems) await mems.ready;
        Controller.singleton = mems;
    } finally {
        Controller.pending = false;
    }
}

export async function disconnect() {
    setAction("Disconnecting from Controller...");
    const { singleton } = Controller;
    if (singleton) {
        if (Controller.pending) throw new Error("Controller is pending");
        Controller.pending = true;
        Controller.singleton = null;
        try {
            await singleton.release();
        } finally {
            Controller.pending = false;
        }
    }
}

watch(
    () => Controller.singleton,
    (c) => {
        (window as any).controller = c;
    }
);
</script>

<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
const icon_style = computed(() => {
    if (Controller.pending) return { "--color": "gray" };
    if (!Controller.singleton) return { "--color": "red" };
    if (!Controller.singleton.enabled) return { "--color": "green" };
    return {
        "--color": "black",
        backgroundColor: "cyan",
    };
});
onMounted(connect);
onUnmounted(disconnect);
const indicator = useTemplateRef<HTMLDivElement>("indicator");
const size = new ElementSize(indicator);
const connected = computed(() => Controller.singleton !== null);
</script>

<template>
    <div class="indicator" ref="indicator" :style="icon_style">
        <svg viewBox="0 0 24 24" class="icon">
            <rect
                class="body"
                x="5.29"
                y="5.29"
                width="13.42"
                height="13.42"
                rx="2"
            ></rect>
            <line class="body" x1="7.21" y1="0.5" x2="7.21" y2="5.29"></line>
            <line class="body" x1="12" y1="0.5" x2="12" y2="5.29"></line>
            <line class="body" x1="16.79" y1="0.5" x2="16.79" y2="5.29"></line>
            <line class="body" x1="7.21" y1="18.71" x2="7.21" y2="23.5"></line>
            <line class="body" x1="12" y1="18.71" x2="12" y2="23.5"></line>
            <line
                class="body"
                x1="16.79"
                y1="18.71"
                x2="16.79"
                y2="23.5"
            ></line>
            <line class="body" x1="0.5" y1="16.79" x2="5.29" y2="16.79"></line>
            <line class="body" x1="0.5" y1="12" x2="5.29" y2="12"></line>
            <line class="body" x1="0.5" y1="7.21" x2="5.29" y2="7.21"></line>
            <line
                class="body"
                x1="18.71"
                y1="16.79"
                x2="23.5"
                y2="16.79"
            ></line>
            <line class="body" x1="18.71" y1="12" x2="23.5" y2="12"></line>
            <line class="body" x1="18.71" y1="7.21" x2="23.5" y2="7.21"></line>
            <circle class="dot" cx="15.83" cy="8.17" r="0.96"></circle>
        </svg>
        <div class="dropdown" :style="{ paddingTop: size.height + 'px' }">
            <div class="dropdown-intent">
                <div class="title">Controller Unit</div>
                <div class="config">
                    <span>Vendor ID:</span
                    ><input
                        v-model="vendorId"
                        :disabled="connected || Controller.pending"
                    />
                </div>
                <div class="config">
                    <span>Product ID:</span
                    ><input
                        v-model="productId"
                        :disabled="connected || Controller.pending"
                    />
                </div>
                <button
                    v-if="!connected"
                    @click="connect"
                    :disabled="Controller.pending"
                >
                    Connect
                </button>
                <button
                    v-else
                    @click="disconnect"
                    :disabled="Controller.pending"
                >
                    Disconnect
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
div.indicator {
    padding: 0.2em;
    border-radius: 0.2em;
    background-color: #0000;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: visible;
    position: relative;

    &:hover {
        outline: 1px solid gray;

        & .dropdown {
            display: flex;
        }
    }

    svg.icon {
        width: 1.2em;
        height: 1.2em;

        .body {
            fill: none;
            stroke: var(--color);
            stroke-miterlimit: 10;
            stroke-width: 1.92px;
        }

        .dot {
            fill: var(--color);
        }
    }

    .dropdown {
        display: none;
        position: absolute;
        z-index: 1000;
        top: 0;
        right: 0;
        background-color: transparent;
        min-width: 20ch;

        .dropdown-intent {
            margin: 0.2em;
            padding: 0.5em;
            background-color: #222;
            border: 1px solid #444;
            border-radius: 4px;
            color: white;
        }

        .title {
            font-weight: bold;
            margin-bottom: 0.5em;
            border-bottom: 2px solid gray;
        }

        .config {
            font-size: 0.9em;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid transparent;

            & > * {
                text-wrap: nowrap;
            }

            &:focus-within {
                border-bottom: 2px solid gray;
            }

            margin: 0.4em 0;
        }

        input {
            width: 6ch;
            text-align: center;
            background: none;
            border: 2px solid transparent;
            color: #ccc;
            outline: none !important;
            font-size: inherit;
            font-family: inherit;
        }

        .button {
            width: 100%;
            text-align: center;
            margin-top: 0.5em;
        }
    }
}
</style>
