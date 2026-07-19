// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// ESM wrapper: use createRequire to load the .node file
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
/**
 * @param {URL} url
 */
// In electron renderer process, import.meta.url is a http URL
// with the path component starting with `/@fs/`
function getRequirePath(url) {
    if (
        ["http:", "https:"].includes(url.protocol) &&
        url.pathname.startsWith("/@fs/")
    )
        return url.pathname.slice(4);
    else return fileURLToPath(url);
}
const require = createRequire(getRequirePath(new URL(import.meta.url)));
const Module = require("./index.cjs");

export default Module;
// Re-expose named exports for nicer ESM ergonomics:
export const {
    Aravis,
    Vision,
    Tracker,
    Port,
    Controller,
    Regression,
    Geometry,
    Log,
    Shm,
    Pipe,
    Topology,
    Recorder,
    steadyNowNs,
    installCrashHandler,
    cleanup,
    __origin__,
} = Module;
