// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { Packet, Protocol, ProtocolMethod, ProtocolProperty } from "core";
import { SerialPort } from "serialport";
import type { PortInfo } from "@serialport/bindings-interface";
import { clamp, defer } from "./util";

type PendingRequest = ReturnType<typeof defer<BufferSource>>;

function volt2dac(volt: number) {
    return clamp((65535 * volt) / 200, [0, 65535]) | 0;
}

function dac2volt(ch: number) {
    return (200 * ch) / 65535;
}

class Controller {
    static async match(match: Partial<PortInfo>) {
        search_loop: for (const info of await SerialPort.list()) {
            for (const [k, v] of Object.entries(match))
                if (info[k as keyof PortInfo] !== v) continue search_loop;
            return info;
        }
    }
    private readonly port: SerialPort;
    private readonly protocol = new Protocol();
    private readonly pending = new Map<number, PendingRequest>();
    private __seq__: number = 1;
    private get sequence() {
        const sequence = this.__seq__;
        this.__seq__ = (this.__seq__ % 65535) + 1;
        return sequence;
    }
    public readonly ready: Promise<void>;
    private onData(data: Buffer) {
        for (const recv of this.protocol.recv(data)) {
            if (recv instanceof Error) {
                console.error("Error parsing packet:", recv);
                continue;
            }
            const { method, property, sequence, payload } = recv;
            try {
                if (method === "ACK") {
                    this.pending.get(sequence)?.resolve(payload);
                } else if (method === "REJ") {
                    this.pending.get(sequence)?.reject("Request rejected: " + Protocol.Log(payload).toString());
                } else if (
                    method === "SYN" &&
                    property === "LOG" &&
                    sequence === 0
                ) {
                    console.log(
                        ["[Controller]", Protocol.Log(payload)].join(" ")
                    );
                } else {
                    console.warn("Unexpected packet:", recv);
                }
            } catch (e) {
                this.pending.get(sequence)?.reject(e);
                this.pending.delete(sequence);
                console.error("Error handling packet:", e, recv);
            } finally {
                this.pending
                    .get(sequence)
                    ?.reject(
                        new Error("Dangling request: " + JSON.stringify(recv))
                    );
                this.pending.delete(sequence);
            }
        }
    }
    constructor(info: PortInfo) {
        this.port = new SerialPort({ ...info, baudRate: 115200 });
        this.ready = new Promise((resolve, reject) => {
            this.port.on("open", resolve);
            this.port.on("error", reject);
        }).then(async () => {
            console.log("Controller connected:", info);
            console.log("  Info:", await this.info);
            console.log("  Version:", await this.version);
            console.log("  Bias Voltage:", await this.setBias(90));
            console.log("  LPF Frequency:", await this.setLPF(120));
            console.log("  Log Level:", await this.setLogLevel("VERB"));
            console.log("(disabling)...", await this.disable());
            window.addEventListener("beforeunload", () => {
                this.disable();
                this.port.flush();
                this.port.close();
            });
        });
        this.port.on("data", this.onData.bind(this));
    }
    private send<T>(
        method: ProtocolMethod,
        property: ProtocolProperty,
        payload: Packet | undefined | null,
        handler: (value: BufferSource) => T
    ): Promise<T> {
        const { sequence } = this;
        const pending = defer<BufferSource>();
        // Clear previous pending request if exists
        this.pending.get(sequence)?.reject(new Error("Timeout"));
        this.pending.set(sequence, pending);
        const buffer = this.protocol.send(method, property, sequence, payload);
        this.port.write(Buffer.from(buffer));
        return pending.promise.then(handler);
    }
    // Protocol-level API
    get<T>(property: ProtocolProperty, handler: (value: BufferSource) => T) {
        return this.send("GET", property, null, handler);
    }
    set<T>(
        property: ProtocolProperty,
        payload: Packet,
        handler: (value: BufferSource) => T
    ) {
        return this.send("SET", property, payload, handler);
    }
    // Application-level API
    get info() {
        return this.get("SYS_INFO", Protocol.System.Info).then(String);
    }
    get version() {
        return this.get("SYS_VERSION", Protocol.System.Version);
    }
    enable() {
        return this.set(
            "SYS_ENABLE",
            Protocol.System.Enable(true),
            Protocol.System.Enable
        );
    }
    disable() {
        return this.set(
            "SYS_ENABLE",
            Protocol.System.Enable(false),
            Protocol.System.Enable
        );
    }
    getLogLevel() {
        return this.get("CFG_LOG", Protocol.Config.Log).then(String);
    }
    setLogLevel(level: "OFF" | "ERR" | "WARN" | "INFO" | "VERB") {
        return this.set(
            "CFG_LOG",
            Protocol.Config.Log(level),
            Protocol.Config.Log
        );
    }
    getLPF() {
        return this.get("CFG_LPF", Protocol.Config.LPF);
    }
    setLPF(value: number) {
        return this.set(
            "CFG_LPF",
            Protocol.Config.LPF(value),
            Protocol.Config.LPF
        );
    }
    private bias: number = 0;
    async getBias() {
        const bias = await this.get("CFG_BIAS", Protocol.Config.Bias);
        this.bias = dac2volt(Number(bias));
        return this.bias;
    }
    async setBias(value: number) {
        const bias = await this.set(
            "CFG_BIAS",
            Protocol.Config.Bias(volt2dac(value)),
            Protocol.Config.Bias
        );
        this.bias = dac2volt(Number(bias));
        return this.bias;
    }
    private volt_diff_max: number = 170.0;
    private ch(volt: number): [number, number] {
        const { bias } = this;
        const dv = Math.max(
            0,
            Math.min(this.bias, 200 - this.bias, this.volt_diff_max / 2)
        );
        const v = clamp(volt / 2, [-dv, dv]);
        return [volt2dac(bias + v), volt2dac(bias - v)];
    }
    private pos(pos: [number, number]): [number, number, number, number] {
        const [x, y] = pos;
        return [...this.ch(x), ...this.ch(y)];
    }
    async actuate(
        left: [number, number],
        right: [number, number],
        settle_time = 0
    ) {
        const ack = await this.set(
            "CMD_ACTUATE",
            Protocol.Command.Actuate({
                left: this.pos(left),
                right: this.pos(right),
                settle_time,
            }),
            Protocol.Command.Actuate
        );
        {
            const { left, right, complete_time } = ack;
            return {
                left: [
                    dac2volt(left[0] - left[1]),
                    dac2volt(left[2] - left[3]),
                ],
                right: [
                    dac2volt(right[0] - right[1]),
                    dac2volt(right[2] - right[3]),
                ],
                complete_time,
            };
        }
    }
    trigger(duration_ns: number) {
        return this.set(
            "CMD_TRIGGER",
            Protocol.Command.Trigger(duration_ns),
            Protocol.Command.Trigger
        );
    }
}

const info = await Controller.match({ vendorId: "16c0", productId: "0483" });
const controller = info ? new Controller(info) : null;
if (controller) await controller.ready;
else console.warn("Controller not found");

export default controller;
