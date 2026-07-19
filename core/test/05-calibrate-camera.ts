#!npx ts-node
// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

let flag_term = false;
const handler = () => {
    console.log("\nTerminating...");
    flag_term = true;
    process.off("SIGINT", handler);
};
process.on("SIGINT", handler);

import { Camera, __origin__, type Frame, type Stream } from "core/Aravis";
import {
    calibrateCamera,
    cornerSubPix,
    findChessboardCorners,
    type Mat,
} from "core/Vision";
import type { Size, Point, Point3d } from "core/Geometry";
console.log("imported", { Camera }, "from", __origin__);

function objectPoints() {
    const ret: Point3d[] = [];
    for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
            ret.push({ x: i * 1.0 - 2.5, y: j * 1.0 - 2.5, z: 0.0 });
        }
    }
    return ret;
}
const obj_points = objectPoints();

// Hardware-independent check that `calibrateCamera` now surfaces OpenCV's RMS
// re-projection error (additive core change). Synthesizes several perfect
// pinhole views of the planar board so the solve is well-conditioned without a
// rig; asserts `rms` is a finite, non-negative number.
async function syntheticRmsCheck() {
    const fx = 800, fy = 800, cx = 320, cy = 240;
    const sensor_size: Size = { width: 640, height: 480 };
    // Rotation Rz*Ry*Rx from Euler angles (radians).
    function rot(rx: number, ry: number, rz: number) {
        const cxx = Math.cos(rx), sx = Math.sin(rx);
        const cyy = Math.cos(ry), sy = Math.sin(ry);
        const czz = Math.cos(rz), sz = Math.sin(rz);
        return [
            [czz * cyy, czz * sy * sx - sz * cxx, czz * sy * cxx + sz * sx],
            [sz * cyy, sz * sy * sx + czz * cxx, sz * sy * cxx - czz * sx],
            [-sy, cyy * sx, cyy * cxx],
        ];
    }
    function project(
        R: number[][],
        t: [number, number, number],
    ): Point[] {
        return obj_points.map((p) => {
            const X = R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z + t[0];
            const Y = R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z + t[1];
            const Z = R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z + t[2];
            return { x: (fx * X) / Z + cx, y: (fy * Y) / Z + cy };
        });
    }
    const poses: Array<{ r: [number, number, number]; t: [number, number, number] }> = [
        { r: [0.2, 0.1, 0.0], t: [0, 0, 10] },
        { r: [-0.2, 0.15, 0.05], t: [1, 0, 11] },
        { r: [0.1, -0.2, -0.05], t: [-1, 1, 9] },
        { r: [-0.15, -0.1, 0.1], t: [0, -1, 10] },
    ];
    const img_pts = poses.map((v) => project(rot(...v.r), v.t));
    const obj_pts = poses.map(() => obj_points);
    const result = await calibrateCamera(sensor_size, img_pts, obj_pts);
    console.log("Synthetic calibration rms:", result.rms);
    if (typeof result.rms !== "number" || !Number.isFinite(result.rms) || result.rms < 0)
        throw new Error(`Expected finite non-negative rms, got ${result.rms}`);
    console.log("Synthetic RMS assertion passed.");
}

await syntheticRmsCheck();

async function detect(stream: Stream<Frame>) {
    type Result = {
        gray: Mat<Uint8Array>;
        img_points: Point[];
    };
    const detections: Result[] = [];
    let sensor_size: Size | null = null;
    for (const frame of stream) {
        if (flag_term) return;
        if (!frame) {
            await new Promise((r) => setTimeout(r, 1));
            continue;
        }
        const { width, height } = frame;
        sensor_size = { width, height };
        const gray = await frame.view("Mono8");
        const img_points = await findChessboardCorners(gray, {
            width: 6,
            height: 6,
        });
        if (img_points.length > 0) {
            console.log(
                "Detected corners:",
                img_points.length,
                ", index:",
                detections.length + 1
            );
            detections.push({ gray, img_points });
            if (flag_term) return;
            if (detections.length >= 2) break;
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    if (detections.length === 0) {
        console.log("No corners detected, skipping calibration.");
        return;
    }
    if (!sensor_size) {
        console.log("No frames captured, skipping calibration.");
        return;
    }
    console.log("Calibrating with", detections.length, "frames...");
    const img_pts = await Promise.all(
        detections.map((d) => cornerSubPix(d.gray, d.img_points))
    );
    const obj_pts = detections.map((d) => obj_points);
    const result = await calibrateCamera(sensor_size, img_pts, obj_pts);
    console.log("Calibration result:", result);
    if (!Number.isFinite(result.rms))
        throw new Error(`Expected finite rms, got ${result.rms}`);
    console.log("Live calibration rms:", result.rms);
}

// List cameras again should not throw error
for (const camera of await Camera.list()) {
    const { serial, exposure, gain, frame_rate } = camera;
    if (serial !== "22071833") {
        console.log("Skipping camera", serial);
        continue;
    }
    console.log(camera, camera.id);
    console.log({ exposure, gain, frame_rate });
    const { stream } = camera;
    console.log({ stream });
    try {
        await detect(stream);
    } catch (e) {
        console.error("Error during detection/calibration:", e);
    }
}
