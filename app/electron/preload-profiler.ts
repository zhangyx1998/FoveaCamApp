// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Profiler-window preload: bridge only, no shm reader — this window renders
// stats, not frames, so it stays `sandbox: true`. Bundled self-contained by
// its own build pass (see preload-bridge.ts header / V11).
import { installBridge } from "./preload-bridge";

installBridge();
