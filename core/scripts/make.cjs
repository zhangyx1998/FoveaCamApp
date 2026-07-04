const { BuildSystem } = require("cmake-js");
const { existsSync, rmSync, mkdirSync, copyFileSync } = require("fs");
const { resolve } = require("path");
const { findOpenCVOptions, getElectronVersion } = require("./env.cjs");

const cmd = process.argv[2];
const arch = process.arch;

const bin = resolve("dist", ".bin");
if (["build", "rebuild", "install"].includes(cmd))
    mkdirSync(bin, { recursive: true });

async function make(runtime, version, arch, options = {}) {
    const prefix = [runtime, version, arch].join("-");
    const buildSystem = new BuildSystem({
        out: resolve("build", prefix),
        runtime: runtime,
        runtimeVersion: version,
        arch: arch,
        cMakeOptions: {
            CMAKE_COLOR_DIAGNOSTICS: process.stdout.isTTY ? "ON" : "OFF",
            ...findOpenCVOptions(),
            ...options,
        },
    });
    if (typeof buildSystem[cmd] !== "function")
        throw new Error(`Unknown command: ${cmd}`);
    console.log(`[${cmd.toUpperCase()}] ${prefix}`);
    await buildSystem[cmd]();
    const src = resolve("build", prefix, "Release", "core.node");
    const dst = resolve(bin, `${prefix}.node`);
    if (["build", "rebuild", "install"].includes(cmd)) copyFileSync(src, dst);
    if (cmd === "clean" && existsSync(dst)) rmSync(dst);
}

async function main() {
    // Create Node.js command
    {
        const runtime = "node";
        const version = process.versions.node;
        await make(runtime, version, arch);
    }
    // Detect if electron is available
    try {
        const runtime = "electron";
        const version = getElectronVersion();
        const options = { CXX_FLAGS: "-DV8_MEMORY_CAGE" };
        await make(runtime, version, arch, options);
    } catch (e) {
        console.log(e.message);
        console.log("Electron not found, skipping electron build");
    }
}

main();
