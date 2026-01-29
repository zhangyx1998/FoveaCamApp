const { resolve } = require("path");
const { writeFileSync, mkdirSync } = require("fs");
const core = require("core");

function mjs(k, m) {
    const named_exports =
        typeof m === "object" ? Object.keys(m).map((f) => `    ${f},`) : [];
    return [
        "// ------------------------------------------------------",
        "// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu",
        "// This source code is licensed under the MIT license.",
        "// You may find the full license in project root directory.",
        "// -------------------------------------------------------",
        `import { ${k} } from "../index.mjs";`,
        `export default ${k};`,
        "export const {",
        ...named_exports,
        "    __origin__,",
        `} = ${k};`,
    ].join("\n");
}

function cjs(k, m) {
    return [
        "// ------------------------------------------------------",
        "// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu",
        "// This source code is licensed under the MIT license.",
        "// You may find the full license in project root directory.",
        "// -------------------------------------------------------",
        `module.exports = require("../index.cjs").${k};`,
    ].join("\n");
}

for (const [k, m] of Object.entries(core)) {
    const dir = resolve(__dirname, "..", "dist", k);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "index.cjs"), cjs(k, m), "utf-8");
    writeFileSync(resolve(dir, "index.mjs"), mjs(k, m), "utf-8");
}
