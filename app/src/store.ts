// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { Camera } from "core";
import { reactive, markRaw } from "vue";

(window as any).Camera = Camera; // for debug

export const cameras = reactive(new Map<string, Camera>());

(window as any).cameras = cameras; // for debug

export function updateCameras() {
    const existing = new Set(cameras.keys());
    const list = Camera.list();
    console.log(list);
    for (const camera of list) {
        existing.delete(camera.serial);
        if (cameras.has(camera.serial)) continue;
        cameras.set(camera.serial, markRaw(camera));
        console.log("Connected:", camera);
    }
    for (const serial of existing) {
        console.log("Disconnected:", cameras.get(serial));
        cameras.delete(serial);
    }
}

updateCameras();
(window as any).updateCameras = updateCameras; // for debug
