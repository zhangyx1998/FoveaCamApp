// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Window/app catalog — the single source of truth for the multi-window
// foundation (Stage 5, docs/refactor/multi-window.md). Imported by the
// renderer (welcome launcher, per-app window shell), the Electron main
// process (window manager entry wiring), vite.config.ts (multi-entry
// renderer build), and the window-manager unit tests. Must stay Vue-free
// and Node-free (pure data + string helpers) so every consumer can load it.
//
// Window taxonomy (multi-window.md §2): `welcome` (singleton, the fallback
// when no app window is open), `app` (≤ 1 at a time — apps are mutually
// exclusive over camera leases + the controller), `profiler` (singleton
// utility; does not count toward the welcome rule), `projection` (0..N
// single-stream viewers — passive subscribers, never exclusive, never
// counted for the welcome rule, survive their source app's close),
// `viewer` (0..N recorder playback windows, ONE PER `.fovea` file —
// non-exclusive, never counted for the welcome rule;
// docs/refactor/recorder-container.md §4).

export type WindowClass = "welcome" | "app" | "profiler" | "projection" | "viewer";

/** URL state params addressing a projection window's stream (multi-window.md
 *  req. 4 — the first state-in-URL consumer): the orchestrator session name
 *  and the frame-channel name within it (e.g. session=tracking, frame=C). */
export type ProjectionParams = { session: string; frame: string };

export interface AppMeta {
  /** Stable id — module directory name; also the entry HTML basename. */
  id: string;
  /** Human-readable window/launcher title. */
  title: string;
  /** Orchestrator session name this app activates (drain target). */
  session: string | null;
  /** Launcher grouping (mirrors the old App.vue sidebar groups). */
  group: "application" | "utility";
  /** Dev-only app (excluded from production launcher + registry). */
  dev?: true;
}

export const APPS: readonly AppMeta[] = [
  // --- applications ---------------------------------------------------
  { id: "disparity-scope", title: "Disparity Scope", session: "disparity-scope", group: "application" },
  { id: "tracking-single", title: "Object Tracking (Single)", session: "tracking", group: "application" },
  { id: "multi-fovea", title: "Object Tracking (Multi)", session: "multi-fovea", group: "application" },
  { id: "manual-control", title: "Manual Control", session: "manual-control", group: "application" },
  { id: "single-capture", title: "Single Capture", session: "liveview", group: "application" },
  { id: "playground", title: "Playground", session: null, group: "application", dev: true },
  // --- utilities --------------------------------------------------------
  { id: "manage-cameras", title: "Manage Cameras", session: "manage-cameras", group: "utility" },
  { id: "calibrate-intrinsic", title: "Calibrate Intrinsic", session: "calibrate-intrinsic", group: "utility" },
  { id: "calibrate-extrinsic", title: "Calibrate Extrinsic", session: "calibrate-extrinsic", group: "utility" },
  { id: "calibrate-distortion", title: "Calibrate Distortion", session: "calibrate-distortion", group: "utility" },
  { id: "calibrate-drift", title: "Calibrate Drift", session: "calibrate-drift", group: "utility" },
] as const;

export function appById(id: string): AppMeta | undefined {
  return APPS.find((a) => a.id === id);
}

/**
 * Entry HTML path (relative to the vite root / renderer dist root) for a
 * window class. Every app gets its own entry URL + HTML (multi-window.md
 * req. 2); welcome and profiler are singleton entries.
 */
export function entryFor(cls: WindowClass, appId?: string): string {
  switch (cls) {
    case "welcome":
      return "windows/welcome.html";
    case "profiler":
      return "windows/profiler.html";
    case "projection":
      return "windows/projection.html";
    case "viewer":
      return "windows/viewer.html";
    case "app": {
      const app = appId && appById(appId);
      if (!app) throw new Error(`Unknown app id: ${appId}`);
      return `windows/${app.id}.html`;
    }
  }
}

/** Every entry HTML the renderer build must emit (vite multi-entry input). */
export function allEntries(): Record<string, string> {
  const entries: Record<string, string> = {
    welcome: "windows/welcome.html",
    profiler: "windows/profiler.html",
    projection: "windows/projection.html",
    viewer: "windows/viewer.html",
  };
  for (const app of APPS) entries[app.id] = `windows/${app.id}.html`;
  return entries;
}

/** Derive the app id back out of an app-window entry URL/pathname (the app
 *  entries all share one script — `src/windows/app-window.ts` reads its own
 *  identity from the page URL). */
export function appIdFromPathname(pathname: string): string | null {
  const m = /(?:^|\/)windows\/([\w-]+)\.html$/.exec(pathname);
  if (!m) return null;
  const id = m[1];
  if (id === "welcome" || id === "profiler" || id === "projection" || id === "viewer")
    return null;
  return appById(id)?.id ?? null;
}
