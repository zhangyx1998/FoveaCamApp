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

const { resolve } = require("node:path");
const dir = resolve(__filename, "..");
const path = resolve(dir, `./.bin/${prefix}`);

const addon = require(path);
const origin = path + ".node";

function injectOrigin(obj) {
    Object.defineProperty(obj, "__origin__", {
        value: origin,
        writable: false,
        enumerable: false,
        configurable: false,
    });
    return obj;
}

for (const el of Object.values(addon)) {
    if (["object", "function"].includes(typeof el) && el !== null)
        injectOrigin(el);
}

module.exports = injectOrigin(addon);
