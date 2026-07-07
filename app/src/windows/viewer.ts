// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// Entry for windows/viewer.html — the `.fovea` recorder playback window
// (A-11, docs/refactor/recorder-container.md §4). The file path rides the
// URL (`?path=…`, state-in-URL req. 7 — also the one-window-per-file key).

import { readUrlParam } from "@lib/url-state";
import { bootWindow } from "./boot";
import ViewerWindow from "./ViewerWindow.vue";

bootWindow(ViewerWindow, { path: readUrlParam("path") ?? "" });
