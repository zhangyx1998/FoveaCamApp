#!/usr/bin/env node
// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Process-boundary gate (npm run check:boundaries). Enforces two invariants as
// TRANSITIVE import walks — a shallow grep of `app/orchestrator/` misses the
// exact case this exists for: a session importing `@lib/config`, which imports
// Vue, pulling all of Vue into the utility process (fixed by @lib/config-schema).
//
//   1. Orchestrator zero-Vue  — nothing reachable from the orchestrator entry
//      (`app/orchestrator/index.ts`) or any module `session.ts` may RUNTIME-
//      import `vue` (a devDependency — it would bundle into the utilityProcess).
//      See architecture/processes.md.
//   2. Renderer zero-core     — nothing reachable from a renderer file (every
//      `.vue` + `app/src/**`) may RUNTIME-import `core` (the native addon).
//      `import type` is fine (type-only erases). Sole exception: the dev-only
//      `modules/playground` scratch module (App Patterns, AGENTS.md).
//
// Zero dependencies, plain Node. Exits non-zero (and prints each violation with
// the import chain that reaches it) on any breach.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "../..");
const APP = join(REPO, "app");

const ALIASES = {
  "@lib": join(APP, "lib"),
  "@orchestrator": join(APP, "orchestrator"),
  "@modules": join(APP, "modules"),
  "@src": join(APP, "src"),
  "@": join(APP, "src"),
};

const PLAYGROUND = join(APP, "modules", "playground") + "/";

// --- fs helpers -------------------------------------------------------------

/** Recursively list files under `dir` matching one of `exts`. */
function walkDir(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkDir(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

// --- import extraction ------------------------------------------------------

/** One import edge: the raw specifier + whether it is type-only (erased). */
function extractImports(file) {
  let src = readFileSync(file, "utf8");
  // Drop comments so an example/import in prose never counts.
  src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
  const edges = [];
  // `import …/export … from "spec"` (multi-line clause tolerated, non-greedy).
  const re =
    /(?:^|\n)\s*(?:import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const clause = m[1].trim();
    edges.push({ spec: m[2], typeOnly: isTypeOnly(clause) });
  }
  // Side-effect imports: `import "spec"` (always runtime).
  const re2 = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while ((m = re2.exec(src))) edges.push({ spec: m[1], typeOnly: false });
  return edges;
}

/** A clause is type-only when it is `type …`, or a brace group whose every
 *  binding is `type X` (e.g. `{ type A, type B }`). */
function isTypeOnly(clause) {
  if (/^type\b/.test(clause)) return true;
  const brace = clause.match(/^\{([\s\S]*)\}$/);
  if (brace) {
    const parts = brace[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length && parts.every((p) => /^type\b/.test(p))) return true;
  }
  return false;
}

// --- specifier resolution ---------------------------------------------------

/** Resolve an import specifier to an absolute in-repo file, or null when it is
 *  external (npm / node builtin / `core` / `vue`). */
function resolveSpec(spec, importer) {
  let base = null;
  if (spec.startsWith(".")) base = resolve(dirname(importer), spec);
  else
    for (const [alias, target] of Object.entries(ALIASES))
      if (spec === alias || spec.startsWith(alias + "/")) {
        base = target + spec.slice(alias.length);
        break;
      }
  if (base === null) return null; // external
  return resolveFile(base);
}

/** Try the extension/index candidates the bundler would (imports carry `.js`
 *  extensions for `.ts`/`.vue` sources). */
function resolveFile(base) {
  const cands = [];
  const push = (p) => cands.push(p);
  if (/\.(ts|tsx|vue|mjs|js)$/.test(base)) {
    push(base);
    push(base.replace(/\.js$/, ".ts"));
    push(base.replace(/\.js$/, ".tsx"));
    push(base.replace(/\.js$/, ".vue"));
  } else {
    push(base + ".ts", base + ".tsx", base + ".vue", base + ".mjs");
    push(join(base, "index.ts"), join(base, "index.vue"), join(base, "index.tsx"));
  }
  for (const p of cands) if (existsSync(p) && statSync(p).isFile()) return p;
  return null;
}

// --- the transitive walk ----------------------------------------------------

/**
 * BFS the runtime-import graph from `roots`. `hit(spec)` decides if a raw
 * specifier is a forbidden LEAF (e.g. `vue`, `core`). Returns violations as
 * `{ file, spec, chain }`. `exempt(file)` skips a file (the playground carve-out).
 */
function scan(roots, hit, exempt) {
  const seen = new Set();
  const violations = [];
  const queue = roots.map((f) => ({ file: f, chain: [f] }));
  while (queue.length) {
    const { file, chain } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec, typeOnly } of extractImports(file)) {
      if (typeOnly) continue; // type-only imports erase — never cross at runtime
      if (hit(spec)) {
        if (!exempt || !exempt(file)) violations.push({ file, spec, chain });
        continue;
      }
      const next = resolveSpec(spec, file);
      if (next && !seen.has(next)) queue.push({ file: next, chain: [...chain, next] });
    }
  }
  return violations;
}

const rel = (p) => p.replace(REPO + "/", "");

function report(title, violations) {
  if (!violations.length) {
    console.log(`  ok  ${title}`);
    return false;
  }
  console.log(`FAIL  ${title} — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.log(`      ${rel(v.file)} imports "${v.spec}"`);
    if (v.chain.length > 1) console.log(`        via ${v.chain.map(rel).join("\n         → ")}`);
  }
  return true;
}

// --- gate 1: orchestrator zero-Vue -----------------------------------------

const orchestratorRoots = [
  join(APP, "orchestrator", "index.ts"),
  ...walkDir(join(APP, "modules"), ["/session.ts"]),
].filter(existsSync);

const vueViolations = scan(
  orchestratorRoots,
  (spec) => spec === "vue" || spec.startsWith("vue/"),
  null,
);

// --- gate 2: renderer zero-core --------------------------------------------

// The dev-only `modules/playground` is the documented carve-out (it is the last
// renderer code allowed to import `core` directly, dev-gated out of production
// by app-registry.ts) — exclude it from the roots so the walk never enters it.
const rendererRoots = [
  ...walkDir(join(APP, "src"), [".ts", ".tsx", ".vue"]),
  ...walkDir(join(APP, "modules"), [".vue"]),
].filter((f) => !f.startsWith(PLAYGROUND));

// `core/types` is a pure `.d.ts` (shared type aliases — TypedArray, Stream, …)
// with NO runtime module: importing it never loads the native addon, so it is
// type-only in substance even in value-import form. Every OTHER `core`/`core/*`
// subpath IS the addon and is forbidden at renderer runtime.
const coreViolations = scan(
  rendererRoots,
  (spec) => (spec === "core" || spec.startsWith("core/")) && spec !== "core/types",
  (file) => file.startsWith(PLAYGROUND),
);

// --- verdict ----------------------------------------------------------------

console.log("Process-boundary gates:");
const failed =
  report("orchestrator zero-Vue", vueViolations) |
  report("renderer zero-core (type-only OK; playground exempt)", coreViolations);

if (failed) {
  console.error("\nBoundary gate FAILED — see violations above.");
  process.exit(1);
}
console.log("\nAll process-boundary gates pass.");
