// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

// node or electron
const runtime = process.versions?.electron ? "electron" : "node";
const version = process.versions?.[runtime];
const arch = process.arch;

if (runtime === undefined || version === undefined || arch === undefined) {
    throw new Error(
        `Cannot determine execution context ${JSON.stringify({
            runtime,
            version,
            arch,
        })}`
    );
}

const prefix = [runtime, version, arch].join("-");

const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const dir = resolve(__filename, "..");
const path = resolve(dir, `./build/${prefix}`);

const core = require(path);
Object.defineProperty(core, "__origin__", {
    value: path + ".node",
    writable: false,
    enumerable: false,
    configurable: false,
});
module.exports = require(path);
