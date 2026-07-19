// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Consolidated per-window boot map. The generated entry HTML
// (`foveaWindowEntries` in vite.config.ts) inlines a single module script that
// calls `bootEntry(<key>)`; this file is the one place that maps an entry key
// to its root component + boot.
//
// The key space matches `@lib/windows` `allEntries()`: the non-app window
// classes are keyed by class name (`welcome`, `profiler`, `projection`,
// `viewer`, `debug`) and each boots its own root component; every other key is
// an app id and boots the shared `AppWindow` shell parametrized by that id
// (the shell resolves the module component via `app-registry.ts`). Class names
// and app ids are disjoint, so the lookup is unambiguous.
//
// Root components are dynamic-imported so each entry's initial chunk stays lean
// (renderer entries MAY share chunks — that restriction applies to preloads only).

import type { Component } from "vue";
import { appById } from "@lib/windows";
import { readUrlParam } from "@lib/url-state";
import { bootWindow } from "./boot";
import AppWindow from "./AppWindow.vue";

type RootLoader = () => Promise<{ default: Component }>;
type SpecialEntry = { load: RootLoader; props?: () => Record<string, unknown> };

// The non-app window classes. `props` reproduces the per-window URL-param
// derivation from the URL (state-in-URL).
const windowRoots: Record<string, SpecialEntry> = {
  welcome: { load: () => import("./WelcomeWindow.vue") },
  profiler: { load: () => import("../profiler/ProfilerWindow.vue") },
  projection: {
    load: () => import("./ProjectionWindow.vue"),
    // Split-view: the layout rides `?layout=` (the
    // live split tree, written back on every change). Seeds fall back to a
    // single-pane `?pane=` descriptor, then the legacy `?session=&frame=` pair
    // — the window resolves the precedence.
    props: () => ({
      layout: readUrlParam("layout") ?? "",
      pane: readUrlParam("pane") ?? "",
      session: readUrlParam("session") ?? "",
      frame: readUrlParam("frame") ?? "",
    }),
  },
  viewer: {
    load: () => import("./ViewerWindow.vue"),
    props: () => ({ path: readUrlParam("path") ?? "" }),
  },
  debug: {
    load: () => import("./DebugWindow.vue"),
    props: () => ({
      session: readUrlParam("session") ?? "",
      kind: readUrlParam("kind") ?? undefined,
    }),
  },
  config: { load: () => import("./ConfigWindow.vue") },
  telecanvas: { load: () => import("./TeleCanvasWindow.vue") },
};

export async function bootEntry(key: string): Promise<void> {
  const special = windowRoots[key];
  if (special) {
    const { default: root } = await special.load();
    bootWindow(root, special.props?.());
    return;
  }
  // Otherwise an app window — the shared shell derives the rest from the id
  // (matching the former `app-window.ts`, which read the id off the URL).
  bootWindow(AppWindow, { appId: appById(key)?.id ?? "unknown" });
}
