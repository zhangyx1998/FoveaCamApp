// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { Camera } from "core";
import { reactive } from "vue";
import { Mutable } from "./types";

export function info(camera?: Camera) {
    const { frame_rate = NaN, exposure = NaN, gain = NaN } = camera ?? {};
    return {
        Vendor: camera?.vendor ?? "Unknown",
        Camera: camera?.model ?? "Unknown",
        Serial: camera?.serial ?? "Unknown",
        FrameRate: `${frame_rate?.toFixed(2) ?? 0} FPS`,
        Exposure: `${(exposure / 1000)?.toFixed(2) ?? 0} ms`,
        Gain: `${gain?.toFixed(2) ?? 0} dB`,
    };
}

export class CameraConfig {
    get info() {
        const { camera } = this;
        return {
            Vendor: camera.vendor,
            Camera: camera.model,
            Serial: camera.serial,
            FrameRate: `${camera.frame_rate.toFixed(2)} FPS`,
            Exposure: `${(camera.exposure / 1000).toFixed(2)} ms`,
            Gain: `${camera.gain.toFixed(2)} dB`,
        };
    }
    constructor(public readonly camera: Camera) {
        Object.assign(this, camera);
    }
}
