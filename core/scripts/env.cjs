const { execFileSync, execSync } = require("child_process");
const { existsSync } = require("fs");
const { resolve } = require("path");

function findOpenCVOptions() {
    if (process.env.OpenCV_DIR) return { OpenCV_DIR: process.env.OpenCV_DIR };

    // Explicit cmake config directories (checked directly for OpenCVConfig.cmake).
    const cmakeDirs = [];
    // Install prefixes under which lib/cmake/opencv4 is probed.
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
    // macOS (Homebrew) prefixes.
    prefixes.push("/opt/homebrew/opt/opencv", "/usr/local/opt/opencv");
    // Linux: ask pkg-config for the install prefix, then add common locations.
    try {
        const prefix = execSync("pkg-config --variable=prefix opencv4", {
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
        if (prefix) prefixes.push(prefix);
    } catch (_) {
        // pkg-config or opencv4.pc may be absent; keep probing known paths.
    }
    prefixes.push("/usr", "/usr/local");
    // Debian/Ubuntu multiarch cmake location doesn't sit under lib/cmake/opencv4.
    cmakeDirs.push("/usr/lib/x86_64-linux-gnu/cmake/opencv4");

    for (const prefix of prefixes) {
        if (prefix) cmakeDirs.push(resolve(prefix, "lib", "cmake", "opencv4"));
    }

    for (const dir of cmakeDirs) {
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
