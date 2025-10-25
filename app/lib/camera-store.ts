// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { setAction } from "@src/components/Loading.vue";
import { Camera, CoreObject, cleanup } from "core";
import { reactive, markRaw } from "vue";

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
