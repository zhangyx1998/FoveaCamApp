const { resolve } = require("path");
const { writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, statSync } = require("fs");
const core = require("core");

// The REAL importable namespaces — exactly the `core/<Name>` subpaths wired in
// core/package.json's `exports` map (each with a hand-written index.d.ts in
// dist/<Name>/). Everything else on the root object (cleanup, steadyNowNs,
// installCrashHandler, __mcap*/__*SelfTest test hooks, and the ROOT-OBJECT-ONLY
// namespaces Port/Recorder — no exports entry, no d.ts, not importable) must
// NOT get a dist dir: the old unconditional loop emitted 13 junk subpath dirs
// that LOOKED importable but weren't (value-sweep 2026-07-11, Tier 4).
const NAMESPACES = [
    "Aravis",
    "Controller",
    "Vision",
    "Tracker",
    "Regression",
    "Geometry",
    "Log",
    "Shm",
    "Pipe",
    "Topology",
];

function mjs(k, m) {
    const named_exports =
        typeof m === "object" ? Object.keys(m).map((f) => `    ${f},`) : [];
    return [
        "// ------------------------------------------------------",
        "// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu",
        "// This source code is licensed under the MIT license.",
        "// You may find the full license in project root directory.",
        "// -------------------------------------------------------",
        // Alias the namespace to a reserved local so a member whose name equals
        // the module name (e.g. `Tracker.Tracker`) doesn't collide with the
        // import binding below — `import { X }` + `const { X }` is a duplicate
        // declaration and the module fails to load.
        `import { ${k} as __ns } from "../index.mjs";`,
        "export default __ns;",
        "export const {",
        ...named_exports,
        "    __origin__,",
        "} = __ns;",
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

const dist = resolve(__dirname, "..", "dist");

for (const k of NAMESPACES) {
    if (!(k in core))
        throw new Error(`code-gen: namespace "${k}" missing from core exports`);
    const dir = resolve(dist, k);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "index.cjs"), cjs(k, core[k]), "utf-8");
    writeFileSync(resolve(dir, "index.mjs"), mjs(k, core[k]), "utf-8");
}

// Sweep residue: any dist subdir that is NOT a wired namespace and holds only
// generated glue (no hand-written d.ts) is a junk emission from the old
// unconditional loop — remove it so the tree stops advertising fake subpaths.
for (const entry of readdirSync(dist)) {
    const dir = resolve(dist, entry);
    if (NAMESPACES.includes(entry) || !statSync(dir).isDirectory()) continue;
    if (entry === ".bin") continue;
    if (existsSync(resolve(dir, "index.d.ts"))) continue; // hand-written — keep
    rmSync(dir, { recursive: true, force: true });
    console.log(`code-gen: removed junk dist subpath ${entry}/`);
}
