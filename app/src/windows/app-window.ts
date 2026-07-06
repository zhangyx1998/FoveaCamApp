// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// Shared entry for every windows/<app>.html — each app has its own entry
// HTML/URL (docs/refactor/multi-window.md req. 2) but they all bootstrap
// through this one script, deriving the app identity from the page URL.

import { appIdFromPathname } from "@lib/windows";
import { bootWindow } from "./boot";
import AppWindow from "./AppWindow.vue";

const appId = appIdFromPathname(location.pathname);
bootWindow(AppWindow, { appId: appId ?? "unknown" });
