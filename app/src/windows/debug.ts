// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// Entry for windows/debug.html — a module's annotation-overlay sub-window
// (WS2 2b). Owner-bound (cascade) to the app that toggled it open; the
// session + frame it annotates ride the URL like a projection window.

import { readUrlParam } from "@lib/url-state";
import { bootWindow } from "./boot";
import DebugWindow from "./DebugWindow.vue";

bootWindow(DebugWindow, {
  session: readUrlParam("session") ?? "",
  frame: readUrlParam("frame") ?? "",
});
