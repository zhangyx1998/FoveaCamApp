#!npx ts-node
// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { SerialPort } from "serialport";
import { type MirrorPosition, Protocol } from "core";
import type { PortInfo } from "@serialport/bindings-interface";

async function getPort(match: Partial<PortInfo>) {
    for (const port of await SerialPort.list()) {
        if (
            Object.entries(match).every(
                ([k, v]) => port[k as keyof PortInfo] === v
            )
        ) {
            return port;
        }
    }
    return null;
}

const info = await getPort({ vendorId: "16c0", productId: "0483" });

if (info === null) {
    console.error("Device not found, did you plug it in?");
    process.exit(1);
} else {
    console.log("Device found:", info);
}

const protocol = new Protocol(info.path);
console.log("Connected:", protocol);

const bias = 90;
await protocol.set(Protocol.System.Enable, false);
console.log(await protocol.get(Protocol.System.Info));
console.log(await protocol.get(Protocol.System.Version));
console.log(await protocol.set(Protocol.Config.Log, "INFO"));
console.log(await protocol.set(Protocol.Config.Bias, 90));
console.log(await protocol.set(Protocol.Config.LPF, 120));

function clamp(val: number, [min, max]: [number, number]) {
    if (val < min) {
        return min;
    } else if (val > max) {
        return max;
    }
    return val;
}

function volt2dac(volt: number) {
    return clamp((65535 * volt) / 200, [0, 65535]) | 0;
}

function dac2volt(ch: number) {
    return (200 * ch) / 65535;
}

async function actuate(v: number, settle_time = 100_000) {
    const dv = v / 2;
    // Top left -> bottom right
    const l: MirrorPosition = [
        volt2dac(bias + dv),
        volt2dac(bias - dv),
        volt2dac(bias + dv),
        volt2dac(bias - dv),
    ];
    // Top right -> bottom left
    const r: MirrorPosition = [
        volt2dac(bias - dv),
        volt2dac(bias + dv),
        volt2dac(bias + dv),
        volt2dac(bias - dv),
    ];
    const { left, right, complete_time } = await protocol.set(
        Protocol.Command.Actuate,
        {
            left: l,
            right: r,
            settle_time,
        }
    );
    return {
        left: [dac2volt(left[0] - left[1]), dac2volt(left[2] - left[3])],
        right: [dac2volt(right[0] - right[1]), dac2volt(right[2] - right[3])],
        complete_time,
    };
}

try {
    console.log(await protocol.set(Protocol.System.Enable, true));
    let v = 0;
    for (; v <= 170; v += 10) console.log(await actuate(v));
    for (; v >= -170; v -= 10) console.log(await actuate(v));
    for (; v <= 0; v += 10) console.log(await actuate(v));
    console.log("Loop finished");
} catch (error) {
    console.error("Error occurred:", error);
}
process.exit(0);
