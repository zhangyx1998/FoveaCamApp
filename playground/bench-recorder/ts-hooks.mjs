// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Module-resolution + transpile shim so the bench can import the UNMODIFIED
// production recorder writer/worker (app/orchestrator/recorder/*) under raw
// node. Two things the production ESM assumes that node's bare resolver/loader
// does not do:
//   - the `@lib/*` (etc.) vite/tsconfig path aliases and `.js`→`.ts` specifiers;
//   - TS features that need real transformation (the writer's constructor
//     parameter properties), which node's strip-only mode rejects.
// The hooks (resolve-hooks.mjs) supply both via esbuild. Register via:
//   /opt/homebrew/bin/node --import ./ts-hooks.mjs src/bench.ts …

import { registerHooks } from "node:module";
import { resolve, load } from "./resolve-hooks.mjs";

registerHooks({ resolve, load });
