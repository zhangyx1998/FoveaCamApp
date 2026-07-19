// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Session unit-test harness —
// plain-TS tests, no Electron: real `Channel`/`ServerSession`/`Hub`
// instances driven by a fake in-memory `Endpoint` pair (`test/
// fake-endpoint.ts`), session `build()` functions exercised against
// `vi.mock`ed registry/controller/store modules. Mirrors `vite.config.ts`'s
// path aliases so test files import the same way application code does.

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
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
