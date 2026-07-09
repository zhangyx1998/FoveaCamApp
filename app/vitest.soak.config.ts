// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// SOAK harness config (capture-recorder-nodes Wave R-2). Separate from the
// standard `vitest.config.ts` gate on purpose: the soak spins up the REAL
// recorder worker over NATIVE fake-camera raw pipes for ~10-20s and decodes the
// resulting `.fovea` — too slow + native-heavy for the per-iteration unit gate.
// Run explicitly (from app/):
//   ../node_modules/.bin/vitest run -c vitest.soak.config.ts
// Duration/rate knobs: SOAK_MS (default 12000).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "..");

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(PROJECT_ROOT, "src"),
      "@lib": resolve(PROJECT_ROOT, "lib"),
      "@src": resolve(PROJECT_ROOT, "src"),
      "@modules": resolve(PROJECT_ROOT, "modules"),
      "@orchestrator": resolve(PROJECT_ROOT, "orchestrator"),
    },
  },
  test: {
    include: ["test/**/*-soak.ts"],
    environment: "node",
    // Native core + a real worker + a long recording: keep everything on ONE
    // process (no pool isolation shenanigans around the .node addon / Worker).
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
