#!npx ts-node
// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { Worker } from "worker_threads";
import { Log, cleanup, __origin__ } from "core";
Log.info("imported core from", __origin__);
 
function isolated() {
    return new Promise<void>((resolve, reject) => {
        const worker = new Worker(
            `
            import { Log, cleanup } from "core";
            import { Camera, __origin__ } from "core/Aravis";
            Log.info("imported", { Camera }, "from", __origin__);
            cleanup();
        `,
            { eval: true }
        );
        worker.on("error", reject);
        worker.on("exit", (code) => {
            if (code !== 0)
                reject(new Error(`Worker stopped with code ${code}`));
            else resolve();
        });
    });
}

for (let i = 0; i < 3; i++) {
    Log.warn(`Iteration ${i + 1}:`);
    await isolated();
    Log.warn("Isolated import and cleanup succeeded.");
}
cleanup();
Log.warn("Global cleanup succeeded.");
