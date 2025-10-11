// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { Camera, CoreObject } from "core";
import { reactive, markRaw } from "vue";

(window as any).Camera = Camera; // for debug

export const cameras = reactive(new Map<string, Camera>());

(window as any).cameras = cameras; // for debug

function is(a: CoreObject | undefined, b: CoreObject | undefined) {
    return a?.id === b?.id;
}

let updating = false;
export async function updateCameras() {
    if (updating) return;
    updating = true;
    try {
        const existing = new Set(cameras.keys());
        const list = await Camera.list();
        for (const camera of list) {
            if (is(cameras.get(camera.serial), camera)) continue;
            existing.delete(camera.serial);
        }
        for (const serial of existing) {
            const camera = cameras.get(serial);
            console.log("Disconnected:", camera?.toString());
            cameras.delete(serial);
            camera?.release();
        }
        for (const camera of list) {
            if (is(cameras.get(camera.serial), camera)) continue;
            console.log("Connected:", camera.toString());
            cameras.set(camera.serial, markRaw(camera));
        }
    } finally {
        updating = false;
    }
}

await updateCameras();
(window as any).updateCameras = updateCameras; // for debug
