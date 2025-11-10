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

import { Camera, __origin__, type Stream, type Frame } from "core/Aravis";
import { MarkerDetector } from "core/Vision";
console.log("imported", { Camera, MarkerDetector }, "from", __origin__);

const cameras = await Camera.list();

console.log("Found", cameras.length, "cameras");
console.log(...cameras);

const detector = new MarkerDetector("4X4_50");
console.log("Created detector:", detector);

async function detect(name: string, stream: Stream<Frame>, scale: number = 1) {
    let counter = 0;
    const s = detector.stream(stream, scale);
    console.log("Created stream:", s);
    for await (const result of s) {
        console.log(name, `detected ${result.length} markers:`);
        for (const d of result) {
            console.log(d.id, d.w, d.h, ...d);
        }
        if (++counter >= 100 || flag_term) break;
    }
}

const tasks: Promise<void>[] = [];
// List cameras again should not throw error
for (const camera of await Camera.list()) {
    console.log(camera, camera.id);
    const { exposure, gain, frame_rate } = camera;
    console.log({ exposure, gain, frame_rate });
    const { stream } = camera;
    console.log({ stream });
    tasks.push(detect(camera.toString(), stream));
}

await Promise.all(tasks);
