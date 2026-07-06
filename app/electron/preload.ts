// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Preload always runs in its own isolated JS context, regardless of the
// window's `contextIsolation` setting — so this is the one place both modes
// share, and the natural spot to land the contextIsolation-compatible
// surface ahead of the actual flip (docs/refactor/orchestrator.md §7.1 T5).
//
// The orchestrator `MessagePort` can't cross `contextBridge` as a function
// argument (structured-clone limits on the bridge itself) — the standard
// pattern is to `window.postMessage` it into the main world instead, which
// works whether or not that world is isolated. `lib/orchestrator/client.ts`
// listens for it via `window.addEventListener("message", ...)`.
import { installBridge } from "./preload-common";

installBridge();
