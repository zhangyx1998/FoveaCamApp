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

import { Camera, __origin__, type Stream } from "core";
console.log("imported", { Camera }, "from", __origin__);

const cameras = await Camera.list();

console.log("Found", cameras.length, "cameras");
console.log(...cameras);

async function capture(stream: Stream, sync = true) {
    let count = 0;
    if (sync) {
        console.log("Acquiring latest frame (sync iter)");
        for (const frame of stream) {
            if (flag_term) break;
            if (!frame) {
                await new Promise((r) => process.nextTick(r));
                continue;
            }
            console.log(frame, frame.id);
            const converted = await frame.view("BGR8");
            console.log("Converted:", converted.byteLength, "bytes");
            frame.release();
            if (++count >= 10) break;
        }
    } else {
        console.log("Acquiring frame queue (async iter)");
        for await (const frame of stream) {
            if (!frame) throw new Error("Should not happen");
            if (flag_term) break;
            console.log(frame, frame.id);
            const converted = await frame.view("BGR8");
            console.log("Converted:", converted.byteLength, "bytes");
            frame.release();
            if (++count >= 10) break;
        }
    }
}

// List cameras again should not throw error
for (const camera of await Camera.list()) {
    console.log(camera, camera.id);
    const { exposure, gain, frame_rate } = camera;
    console.log({ exposure, gain, frame_rate });
    const { stream } = camera;
    console.log({ stream });
    await capture(stream, true);
    await new Promise((r) => setTimeout(r, 100));
    await capture(stream, false);
    stream.release();
    camera.release();
}
