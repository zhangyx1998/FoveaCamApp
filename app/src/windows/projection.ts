// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// Entry for windows/projection.html — a single-stream viewer window
// (docs/refactor/multi-window.md req. 4). The stream address rides the URL
// (`?session=…&frame=…`, the first state-in-URL consumer, req. 7).

import { readUrlParam } from "@lib/url-state";
import { bootWindow } from "./boot";
import ProjectionWindow from "./ProjectionWindow.vue";

bootWindow(ProjectionWindow, {
  session: readUrlParam("session") ?? "",
  frame: readUrlParam("frame") ?? "",
});
