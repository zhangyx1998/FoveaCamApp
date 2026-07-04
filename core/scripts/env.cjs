const { execFileSync, execSync } = require("child_process");
const { existsSync } = require("fs");
const { resolve } = require("path");

function findOpenCVOptions() {
    if (process.env.OpenCV_DIR) return { OpenCV_DIR: process.env.OpenCV_DIR };

    const prefixes = [];
    try {
        prefixes.push(
            execSync("brew --prefix opencv", { stdio: ["ignore", "pipe", "ignore"] })
                .toString()
                .trim(),
        );
    } catch (_) {
        // Homebrew is optional; fall back to common install locations below.
    }
    prefixes.push("/opt/homebrew/opt/opencv", "/usr/local/opt/opencv");

    for (const prefix of prefixes) {
        if (!prefix) continue;
        const dir = resolve(prefix, "lib", "cmake", "opencv4");
        if (existsSync(resolve(dir, "OpenCVConfig.cmake"))) return { OpenCV_DIR: dir };
    }

    return {};
}

function getElectronVersion() {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    return execFileSync(npx, ["electron", "-p", "process.versions.electron"], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    })
        .toString()
        .trim();
}

module.exports = {
    findOpenCVOptions,
    getElectronVersion,
};
