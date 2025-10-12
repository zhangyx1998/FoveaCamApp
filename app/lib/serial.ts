// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { Protocol, type LogLevel, type PacketFactory } from "core";
import { SerialPort } from "serialport";
import type { PortInfo } from "@serialport/bindings-interface";
import { clamp, defer } from "./util";

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
    public readonly ready: Promise<void>;
    constructor(info: PortInfo) {
        this.port = new SerialPort({ ...info, baudRate: 115200 });
        this.ready = new Promise((resolve, reject) => {
            this.port.on("open", resolve);
            this.port.on("error", reject);
        }).then(async () => {
            this.protocol.__tx__ = (data) => this.port.write(Buffer.from(data));
            this.port.on("close", () => {
                this.protocol.__tx__ = null;
            });
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
        this.port.on("data", (data: Buffer) => this.protocol.__rx__(data));
    }
    private get<T>(prop: PacketFactory<T>) {
        return this.protocol.get(prop);
    }
    private set<T>(prop: PacketFactory<T>, arg: T | BufferLike) {
        return this.protocol.set(prop, arg);
    }
    // Application-level API
    get info() {
        return this.get(Protocol.System.Info);
    }
    get version() {
        return this.get(Protocol.System.Version);
    }
    enable() {
        return this.set(Protocol.System.Enable, true);
    }
    disable() {
        return this.set(Protocol.System.Enable, false);
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
        const ack = await this.set(Protocol.Command.Actuate, {
            left: this.pos(left),
            right: this.pos(right),
            settle_time,
        });
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
        return this.set(Protocol.Command.Trigger, duration_ns);
    }
    // Demo movement
    async demo() {
        await this.enable();
        let v = 0;
        for (; v <= 170; v += 1)
            console.log(await this.actuate([+v, +v], [-v, +v], 10_000));
        for (; v >= -170; v -= 1)
            console.log(await this.actuate([+v, +v], [-v, +v], 10_000));
        for (; v <= 0; v += 1)
            console.log(await this.actuate([+v, +v], [-v, +v], 10_000));
        await this.disable();
        console.log("Demo finished");
    }
}

const info = await Controller.match({ vendorId: "16c0", productId: "0483" });
const controller = info ? new Controller(info) : null;
if (controller) await controller.ready;
else console.warn("Controller not found");

export default controller;
