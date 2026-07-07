// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Synchronous `resolve` + `load` hooks (registered by ts-hooks.mjs via
// module.registerHooks) that let the bench load the production recorder ESM
// as-is:
//   - `resolve` expands the repo's path aliases and falls back from a `.js`
//     (or extensionless) specifier to the real `.ts` source;
//   - `load` transpiles `.ts` via esbuild (already in the repo's node_modules,
//     via vite/vitest) — node's strip-only mode rejects TS features that need
//     real transformation, e.g. the writer's constructor parameter properties.
// No new dependency is added.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const REPO = new URL("../../", import.meta.url);

// Mirror of the vite/tsconfig aliases the orchestrator source uses.
const ALIASES = {
  "@lib/": "app/lib/",
  "@orchestrator/": "app/orchestrator/",
  "@modules/": "app/modules/",
  "@src/": "app/src/",
  "@/": "app/src/",
};

const HAS_EXT = /\.(?:[cm]?[jt]sx?|json|node)$/;

export function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  for (const [prefix, target] of Object.entries(ALIASES)) {
    if (spec.startsWith(prefix)) {
      spec = new URL(target + spec.slice(prefix.length), REPO).href;
      break;
    }
  }

  const attempts = [spec];
  if (spec.endsWith(".js")) attempts.push(spec.slice(0, -3) + ".ts");
  else if (!HAS_EXT.test(spec.split("?")[0])) attempts.push(spec + ".ts");

  let lastError;
  for (const candidate of attempts) {
    try {
      return nextResolve(candidate, context);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function load(url, context, nextLoad) {
  const path = url.split("?")[0];
  if (url.startsWith("file:") && path.endsWith(".ts")) {
    const file = fileURLToPath(url);
    const { code } = transformSync(readFileSync(file, "utf8"), {
      loader: "ts",
      format: "esm",
      target: "esnext",
      sourcefile: file,
    });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
