// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { Camera } from "core";
import { reactive, markRaw, Raw } from "vue";

export const cameras = reactive(new Map<string, Camera>());

(window as any).cameras = cameras; // for debug

function updateCameras() {
    const existing = new Set(cameras.keys());
    for (const camera of Camera.list()) {
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
// setInterval(updateCameras, 1000);

// renderer.ts
import { usb, type Device } from "usb";

// Avoid duplicate handlers during HMR
const onAttach = (d: Device) => {
    console.log("[usb] attach", describe(d));
    updateCameras();
};
const onDetach = (d: Device) => {
    console.log("[usb] detach", describe(d));
    updateCameras();
};

function describe(d: Device) {
    return {
        busNumber: d.busNumber,
        deviceAddress: d.deviceAddress,
        vendorId: d.deviceDescriptor?.idVendor,
        productId: d.deviceDescriptor?.idProduct,
    };
}

usb.removeListener("attach", onAttach);
usb.removeListener("detach", onDetach);
usb.on("attach", onAttach);
usb.on("detach", onDetach);

// (Optional) cleanup on hot reload/navigation
window.addEventListener("beforeunload", () => {
    usb.removeListener("attach", onAttach);
    usb.removeListener("detach", onDetach);
});
