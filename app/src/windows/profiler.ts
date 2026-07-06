// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// Entry for windows/profiler.html — the read-only profiler window
// (previously loaded index.html?profiler=1; now a first-class entry of the
// multi-entry renderer build, docs/refactor/multi-window.md req. 2).

import { bootWindow } from "./boot";
import ProfilerWindow from "../profiler/ProfilerWindow.vue";

bootWindow(ProfilerWindow);
