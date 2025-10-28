// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { setAction } from "@src/components/Loading.vue";
import { Camera, cleanup } from "core";
import Store from "./store";
import { Triple } from "./types";

window.addEventListener("beforeunload", cleanup);

class Cameras extends Map<string, Camera> {
    private static instance: Cameras | null = null;
    readonly creator: string;
    constructor(cameras: Array<Camera>) {
        if (Cameras.instance)
            throw new Error(
                "Existing Cameras instance found: " + Cameras.instance.creator
            );
        super(cameras.map((cam) => [cam.serial, cam]));
        this.creator = new Error().stack || "unknown";
        (window as any).cameras = this;
    }
    public release() {
        for (const cam of this.values()) cam.release();
        this.clear();
        Cameras.instance = null;
    }
}

export default async function useCameras() {
    setAction("Scanning for cameras...");
    return new Cameras(await Camera.list());
}

type MatchedCameras = Partial<Triple<Camera>> & {
    release(): void;
};

export async function useMatchedCameras(): Promise<MatchedCameras> {
    const cams = await useCameras();
    const matched: MatchedCameras = {
        release() {
            cams.release();
        },
    };
    for (const cam of cams.values()) {
        const store = await getCameraStore(cam);
        switch (store.role) {
            case "L":
                matched.L ??= initCamera(cam, store);
                break;
            case "C":
                matched.C ??= initCamera(cam, store);
                break;
            case "R":
                matched.R ??= initCamera(cam, store);
                break;
        }
    }
    return matched;
}

export function describeCamera(camera: Camera | undefined | null) {
    if (!camera) return "Camera Not Connected";
    return `${camera.vendor} ${camera.model} (${camera.serial})`;
}

function normalizePathSegment(segment: string) {
    return segment.trim().replace(/\s+/g, "-");
}

export function getCameraKey(camera: Camera) {
    return [camera.vendor, camera.model, camera.serial]
        .map(normalizePathSegment)
        .join("_");
}

export function getCameraStore(camera: Camera) {
    const key = getCameraKey(camera);
    return Store.open<Camera & { role?: keyof Triple }>("cameras", key);
}

export function initCamera(camera: Camera, config: Partial<Camera>) {
    if (config.frame_rate_enable !== undefined)
        camera.frame_rate_enable = config.frame_rate_enable;
    if (!camera.frame_rate_enable && config.frame_rate !== undefined)
        camera.frame_rate = config.frame_rate;
    if (config.exposure_auto !== undefined)
        camera.exposure_auto = config.exposure_auto;
    if (camera.exposure_auto === "Off" && config.exposure !== undefined)
        camera.exposure = config.exposure;
    if (config.gain_auto !== undefined) camera.gain_auto = config.gain_auto;
    if (camera.gain_auto === "Off" && config.gain !== undefined)
        camera.gain = config.gain;
    return camera;
}
