#!npx ts-node
// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { Camera, __origin__ } from "core/Aravis";
import type { Mat } from "core/Vision";
console.log("imported", { Camera }, "from", __origin__);

function check(mat: Mat) {
    const { shape, channels, length } = mat;
    console.log("Mat:", {
        shape,
        channels,
        length,
        expected: shape.reduce((a, b) => a * b, channels),
    });
}

// List cameras again should not throw error
for (const camera of await Camera.list()) {
    console.log(camera, camera.id);
    const { exposure, gain, frame_rate } = camera;
    console.log({ exposure, gain, frame_rate });
    const frame = await camera.grab();
    console.log("Frame:", frame);
    console.log("View(raw):", check(await frame.view()));
    console.log("View(Mono8):", check(await frame.view("Mono8")));
    console.log("View(BGRA8):", check(await frame.view("BGRA8")));
    frame.release();
}
