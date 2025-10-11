const { execSync } = require("child_process");
const { BuildSystem } = require("cmake-js");
const { readFileSync, existsSync, writeFileSync, rmSync } = require("fs");

const cmd = process.argv[2];
const arch = process.arch;

async function make(runtime, version, arch, options = {}) {
    const prefix = [runtime, version, arch].join("-");
    const buildSystem = new BuildSystem({
        out: `build/${prefix}`,
        runtime: runtime,
        runtimeVersion: version,
        arch: arch,
        cMakeOptions: {
            CMAKE_COLOR_DIAGNOSTICS: process.stdout.isTTY ? "ON" : "OFF",
            ...options,
        },
    });
    if (typeof buildSystem[cmd] !== "function")
        throw new Error(`Unknown command: ${cmd}`);
    console.log(`[${cmd.toUpperCase()}] ${prefix}`);
    await buildSystem[cmd]();
    const src = `build/${prefix}/Release/core.node`;
    const dst = `build/${prefix}.node`;
    if (["build", "rebuild", "install"].includes(cmd))
        execSync(`cp ${src} ${dst}`, { stdio: "inherit" });
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
        const version = execSync("npx electron --version")
            .toString()
            .replace(/^v/, "")
            .trim();
        const options = { CXX_FLAGS: "-DV8_MEMORY_CAGE" };
        await make(runtime, version, arch, options);
    } catch (e) {
        console.log(e.message);
        console.log("Electron not found, skipping electron build");
    }
}

main();
