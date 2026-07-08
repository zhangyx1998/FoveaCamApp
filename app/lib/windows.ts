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

export type WindowClass =
  | "welcome"
  | "app"
  | "profiler"
  | "projection"
  | "viewer"
  | "debug";

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

type AppSpec = Omit<AppMeta, "id">;

export const APP_REGISTRY = {
  // --- applications ---------------------------------------------------
  "disparity-scope": {
    title: "Disparity Scope",
    session: "disparity-scope",
    group: "application",
  },
  "tracking-single": {
    title: "Tracking - Single",
    session: "tracking",
    group: "application",
  },
  "multi-fovea": {
    title: "Tracking - Multi",
    session: "multi-fovea",
    group: "application",
  },
  "manual-control": {
    title: "Manual Control",
    session: "manual-control",
    group: "application",
  },
  "single-capture": {
    title: "Single Capture",
    session: "liveview",
    group: "application",
  },
  playground: {
    title: "Playground",
    session: null,
    group: "application",
    dev: true,
  },
  // --- utilities ------------------------------------------------------
  "manage-cameras": {
    title: "Manage Cameras",
    session: "manage-cameras",
    group: "utility",
  },
  "calibrate-intrinsic": {
    title: "Calibrate Intrinsic",
    session: "calibrate-intrinsic",
    group: "utility",
  },
  "calibrate-extrinsic": {
    title: "Calibrate Extrinsic",
    session: "calibrate-extrinsic",
    group: "utility",
  },
  "calibrate-distortion": {
    title: "Calibrate Distortion",
    session: "calibrate-distortion",
    group: "utility",
  },
  "calibrate-drift": {
    title: "Calibrate Drift",
    session: "calibrate-drift",
    group: "utility",
  },
} as const satisfies Record<string, AppSpec>;

export type AppId = keyof typeof APP_REGISTRY;

function appFromEntry(id: string, spec: AppSpec): AppMeta {
  return { id, ...spec };
}

export const APPS: readonly AppMeta[] = Object.entries(APP_REGISTRY).map(
  ([id, spec]) => appFromEntry(id, spec),
);

export function appById(id: string): AppMeta | undefined {
  const spec = APP_REGISTRY[id as AppId];
  return spec ? appFromEntry(id, spec) : undefined;
}

/** Preload bundle a window class loads — a pure key mapped to a concrete file
 *  main-side (main.ts's options adapter), so this module stays Node-free.
 *  `renderer` = bridge + shm reader (`sandbox: false`); `profiler` = sandboxed
 *  bridge only. */
export type PreloadKind = "renderer" | "profiler";

/** Constructor size + minimums for a window class — Electron-agnostic; main.ts
 *  merges these into `BrowserWindowConstructorOptions`. */
export interface WindowSizeSpec {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
}

/**
 * One row of the window taxonomy (multi-window.md §2) — the single source of
 * truth every window consumer derives from: the renderer launcher, the main
 * window manager + its metadata→BrowserWindowOptions adapter, the manifest
 * restore planner, and the vite multi-entry build. Centralizing it means a new
 * window class can't silently miss an invariant (singleton status, exclusivity,
 * preload/sandbox mode, welcome-rule participation) across those files.
 */
export interface WindowSpec {
  /** Only ever one instance; a second open focuses the existing one (welcome,
   *  profiler). Distinct from `exclusive` — app is ≤ 1 via drain/switch. */
  singleton: boolean;
  /** Mutually exclusive over camera leases + the controller: at most one open,
   *  opening another drains then switches (app only). */
  exclusive: boolean;
  /** Participates in the welcome rule — welcome shows whenever zero of these
   *  are open (app only; utilities/projections/viewers don't count). */
  countsForWelcome: boolean;
  /** `WindowDescriptor` field that dedupes instances (viewer → one per file);
   *  omitted for 0..N classes with no dedupe. */
  dedupe?: "fileKey";
  /** What happens to a window of this class when its `owner` window closes
   *  (WS2 2a, project-multi-subwindow-per-app): `cascade` = close with the
   *  owner (2b's debug drawer); `survive` = stay open (projection/viewer keep
   *  their frozen last frame, §5.3). Ownerless windows ignore this. */
  onOwnerClose: "cascade" | "survive";
  /** Static entry HTML (relative to the renderer root). App windows derive a
   *  per-id entry instead — see `entryFor`. */
  entry?: string;
  preload: PreloadKind;
  sandbox: boolean;
  /** Base window title; app windows append the app's own title. */
  title: string;
  bounds: WindowSizeSpec;
}

export const WINDOWS: Record<WindowClass, WindowSpec> = {
  welcome: {
    singleton: true,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "survive",
    entry: "windows/welcome.html",
    // Live annotated previews need the shm reader (multi-window.md §2).
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo",
    bounds: { width: 1100, height: 720, minWidth: 800, minHeight: 560 },
  },
  app: {
    // ≤ 1 at a time via `exclusive` (drain/switch), not the singleton-focus path.
    singleton: false,
    exclusive: true,
    countsForWelcome: true,
    onOwnerClose: "survive",
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo",
    bounds: { width: 1200, height: 900, minWidth: 800, minHeight: 600 },
  },
  profiler: {
    singleton: true,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "survive",
    entry: "windows/profiler.html",
    // Sandboxed, bridge-only — no shm reader (stats over the bridge).
    preload: "profiler",
    sandbox: true,
    title: "FoveaCam Duo — Profiler",
    bounds: { width: 720, height: 800 },
  },
  projection: {
    singleton: false,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "survive",
    entry: "windows/projection.html",
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo — Projection",
    bounds: { width: 960, height: 640, minWidth: 320, minHeight: 240 },
  },
  viewer: {
    singleton: false,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "survive",
    dedupe: "fileKey",
    entry: "windows/viewer.html",
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo — Viewer",
    bounds: { width: 1100, height: 760, minWidth: 640, minHeight: 420 },
  },
  debug: {
    // WS2 2b: a module's annotation-overlay sub-window. Owner-bound — the
    // FIRST class to opt into cascade (closes with its opener app; A-20/2a).
    // Projection-style: renderer preload (shm reader), passive subscriber.
    singleton: false,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "cascade",
    entry: "windows/debug.html",
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo — Debug",
    bounds: { width: 720, height: 560, minWidth: 320, minHeight: 240 },
  },
};

/**
 * Entry HTML path (relative to the vite root / renderer dist root) for a
 * window class. Every app gets its own entry URL + HTML (multi-window.md
 * req. 2); the singleton/utility classes carry a static entry in `WINDOWS`.
 */
export function entryFor(cls: WindowClass, appId?: string): string {
  if (cls === "app") {
    const app = appId && appById(appId);
    if (!app) throw new Error(`Unknown app id: ${appId}`);
    return `windows/${app.id}.html`;
  }
  return WINDOWS[cls].entry!;
}

/** Every entry HTML the renderer build must emit (vite multi-entry input): the
 *  static class entries from `WINDOWS` plus one per app. */
export function allEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [cls, spec] of Object.entries(WINDOWS))
    if (spec.entry) entries[cls] = spec.entry;
  for (const id of Object.keys(APP_REGISTRY))
    entries[id] = `windows/${id}.html`;
  return entries;
}

/** Derive the app id back out of an app-window entry URL/pathname (the app
 *  entries all share one script — `src/windows/app-window.ts` reads its own
 *  identity from the page URL). */
export function appIdFromPathname(pathname: string): string | null {
  const m = /(?:^|\/)windows\/([\w-]+)\.html$/.exec(pathname);
  if (!m) return null;
  const id = m[1];
  if (
    id === "welcome" ||
    id === "profiler" ||
    id === "projection" ||
    id === "viewer"
  )
    return null;
  return appById(id)?.id ?? null;
}
