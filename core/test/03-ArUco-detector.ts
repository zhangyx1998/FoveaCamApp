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

async function detect(stream: Stream<Frame>) {
    let frame: Frame | null = null;
    for await (frame of stream) {
        if (frame) break;
    }
    if (!frame) throw new Error("Stream ended before a frame was captured");
    console.log("Captured frame:", frame, frame.id);
    const result = await detector.detect(frame);
    console.log(`Detected ${result.length} markers:`);
    for (const d of result) {
        console.log(d.id, d.width, d.height, ...d);
    }
    frame.release();
}

// List cameras again should not throw error
for (const camera of await Camera.list()) {
    console.log(camera, camera.id);
    const { exposure, gain, frame_rate } = camera;
    console.log({ exposure, gain, frame_rate });
    const { stream } = camera;
    console.log({ stream });
    await detect(stream);
}
