// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Main-process window state machine (docs/history/refactor/multi-window.md §3):
// registry of open windows by class, the welcome rule, app exclusivity with
// drain-aware switching, and manifest collection for the dev restart flow.
// Subsumes the old ad-hoc `openProfilerWindow` handler.
//
// Deliberately Electron-free: every platform effect goes through injected
// deps (`spawn` creates the real BrowserWindow in main.ts; `drainSessions`
// asks the orchestrator to idle every camera-owning session and waits for
// settlement; `notifyRefusal` surfaces a busy refusal). This keeps the
// state machine unit-testable with fakes (`test/window-manager.test.ts`).
//
// Adopted defaults (multi-window.md §5, user-vetoable):
//   1. Welcome CLOSES on app open (respawns when the last app window closes).
//   2. Opening app B while A is open = SWITCH: drain A's session first, then
//      spawn B — "closed" means session-idle-drained, not window-destroyed.
//      Refuse (keeping A) only if A is mid-capture/recording.
//
// Drain ordering note: the drain happens BEFORE the old windows close — the
// busy check must be able to refuse while A is still intact, and a drained
// session makes the subsequent window close's own unsubscribe a no-op. The
// welcome window is camera-holding (live previews, §4), so welcome→app rides
// the exact same path as app→app.

import {
  entryFor,
  WINDOW_ID_PARAM,
  WINDOWS,
  type ProjectionParams,
  type WindowClass,
} from "@lib/windows";
import type { ManifestWindow, WindowBounds, WindowManifest } from "./window-manifest.js";

export interface WindowDescriptor {
  class: WindowClass;
  appId?: string;
  /** Entry path relative to the renderer root (dev URL / dist file). */
  entry: string;
  /** URL query string (starts with "?") carrying state-in-URL params
   *  (multi-window.md req. 7) — appended to the dev-server URL or passed as
   *  `loadFile`'s `search` in a packaged build. */
  search?: string;
  /** Restore geometry (from a manifest); spawn uses defaults when absent. */
  bounds?: WindowBounds;
  /** Spawn full-screen / maximized — inherited from the switched-from window
   *  on welcome↔app switches so the new window lands exactly where (and how)
   *  the old one was. */
  fullscreen?: boolean;
  maximized?: boolean;
  /** Full landing URL to restore (overrides `entry` when given — carries the
   *  state params, multi-window.md req. 7). */
  url?: string;
  /** Viewer windows: the opened `.fovea` path — the one-window-per-file
   *  dedupe key (recorder-container.md §4). */
  fileKey?: string;
  /** WS2 2a: the parent window this one belongs to (a sub-window of an app).
   *  When the owner closes, this window's class `onOwnerClose` policy decides
   *  whether it cascades closed or survives. Undefined for top-level windows. */
  owner?: ManagedWindow;
  /** WS2 2a: dedupe key for the `toggle` primitive (2b's debug drawer) — the
   *  generalized form of `fileKey`'s open-or-focus dedupe, plus a close path. */
  key?: string;
  /** Stable per-instance id (A-34): minted by the manager at spawn
   *  (`<appId|class>-<n>`, unique among LIVE windows) and threaded into the
   *  window URL as `?win=` so the renderer knows its own identity and it
   *  survives reloads + manifest restores. Callers never set this — the
   *  manager's `spawn()` wrapper fills it (or recovers it from a restored
   *  URL). */
  windowId?: string;
}

/** The window handle surface the manager needs — main.ts adapts a real
 *  BrowserWindow onto this; tests use fakes. */
export interface ManagedWindow {
  readonly class: WindowClass;
  readonly appId?: string;
  /** Mirror of `WindowDescriptor.fileKey` (viewer windows only). */
  readonly fileKey?: string;
  /** Mirror of `WindowDescriptor.owner` (sub-windows only) — WS2 2a. */
  readonly owner?: ManagedWindow;
  /** Mirror of `WindowDescriptor.key` (toggle-managed windows) — WS2 2a. */
  readonly key?: string;
  /** Mirror of `WindowDescriptor.windowId` (A-34) — every spawned window has
   *  one (optional only for pre-A-34 fakes/tests). */
  readonly windowId?: string;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  getURL(): string;
  getBounds(): WindowBounds;
  /** Display state for switch inheritance. Optional (pre-existing fakes);
   *  main.ts's adapter answers from a last-known snapshot once the
   *  BrowserWindow is destroyed (the welcome rule fires AFTER close). */
  isFullScreen?(): boolean;
  isMaximized?(): boolean;
}

/** The switch-inheritance snapshot of a window's display state. */
function displayStateOf(w: ManagedWindow): {
  bounds: WindowBounds;
  fullscreen: boolean;
  maximized: boolean;
} {
  return {
    bounds: w.getBounds(),
    fullscreen: w.isFullScreen?.() ?? false,
    maximized: w.isMaximized?.() ?? false,
  };
}

export interface DrainResult {
  ok: boolean;
  reason?: string;
}

/** Query string of a (possibly invalid/absent) URL, or undefined. */
function searchOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).search || undefined;
  } catch {
    return undefined;
  }
}

/** The `?win=` id carried by a (possibly absent) URL or search string — how a
 *  manifest-restored window keeps its pre-restart identity (A-34). */
export function windowIdOf(urlOrSearch: string | undefined): string | undefined {
  if (!urlOrSearch) return undefined;
  const search = urlOrSearch.startsWith("?") ? urlOrSearch : searchOf(urlOrSearch);
  if (!search) return undefined;
  return new URLSearchParams(search).get(WINDOW_ID_PARAM) ?? undefined;
}

export interface WindowManagerDeps {
  spawn(desc: WindowDescriptor): ManagedWindow;
  /** Idle every camera-owning session orchestrator-side and resolve once the
   *  releases settle; `{ok: false}` = refused (a session is mid-capture/
   *  recording) and NOTHING was drained. */
  drainSessions(): Promise<DrainResult>;
  /** Surface a switch refusal to the user (dialog in main.ts). */
  notifyRefusal(reason: string): void;
}

export class WindowManager {
  private readonly windows = new Set<ManagedWindow>();
  // Serializes switches: a second openApp while one is mid-drain queues
  // behind it instead of racing the drain/spawn sequence.
  private switching: Promise<void> = Promise.resolve();
  private inSwitch = false;
  private quitting = false;

  constructor(private readonly deps: WindowManagerDeps) {}

  /** All open (non-destroyed) windows, pruning any that died silently. */
  open(): ManagedWindow[] {
    for (const w of [...this.windows])
      if (w.isDestroyed()) this.windows.delete(w);
    return [...this.windows];
  }

  private byClass(cls: WindowClass): ManagedWindow[] {
    return this.open().filter((w) => w.class === cls);
  }

  appWindow(): ManagedWindow | null {
    return this.byClass("app")[0] ?? null;
  }

  /** Open sub-windows owned by `win` (WS2 2a). */
  childrenOf(win: ManagedWindow): ManagedWindow[] {
    return this.open().filter((w) => w.owner === win);
  }

  /** Main.ts must call this from the BrowserWindow "closed" event. */
  onWindowClosed(win: ManagedWindow): void {
    this.windows.delete(win);
    // WS2 2a: cascade-close owned children whose CLASS opts into it. A
    // `survive` child (projection/viewer default) stays open with its frozen
    // last frame; a `cascade` child (2b's debug drawer) closes with its owner.
    // Closing a child re-enters here for it, so grandchildren cascade too.
    for (const child of this.childrenOf(win))
      if (WINDOWS[child.class].onOwnerClose === "cascade" && !child.isDestroyed())
        child.close();
    // Welcome rule: whenever zero app windows are open, the welcome window
    // comes back — but only when an APP window closing got us there (closing
    // welcome itself must not respawn it under the user's cursor), and not
    // mid-switch (the gap between "A closed" and "B spawned" is not "no app
    // open") or during quit.
    if (!WINDOWS[win.class].countsForWelcome) return;
    if (this.quitting || this.inSwitch) return;
    // Switch inheritance (app→welcome direction): the respawned welcome lands
    // where the closed app window was. The BrowserWindow is destroyed by now —
    // main.ts's adapter answers these from its last-known snapshot.
    if (this.appWindow() === null) this.ensureWelcome(displayStateOf(win));
  }

  /** App is quitting — stop enforcing the welcome rule. */
  markQuitting(): void {
    this.quitting = true;
  }

  /** Quit teardown (orchestrator-lifecycle-and-exit gap 5): close owned
   *  sub-windows FIRST so their `onOwnerClose` cascade runs before the app/top
   *  windows they belong to, then everything else — establishing the
   *  window-first order (sub-windows → app windows → orchestrator handshake).
   *  `markQuitting()` must already have suspended the welcome rule so no
   *  respawn races this. Idempotent; safe to call once from `before-quit`. */
  closeAll(): void {
    const all = this.open();
    const owned = all.filter((w) => w.owner);
    const rest = all.filter((w) => !w.owner);
    for (const w of owned) if (!w.isDestroyed()) w.close();
    for (const w of rest) if (!w.isDestroyed()) w.close();
  }

  private track(win: ManagedWindow): ManagedWindow {
    this.windows.add(win);
    return win;
  }

  // A-34: stable per-instance window identity. Monotonic mint counter —
  // uniqueness matters among LIVE windows (+ stability across reloads/manifest
  // restores, which recover the id from the persisted URL); collisions after
  // a restore are dodged by probing the live set.
  private idCounter = 0;

  /** Single spawn chokepoint: resolves the window's stable id (recovered from
   *  a restored URL, else minted `<appId|class>-<n>`), threads it into the
   *  spawn URL as `?win=` (state-in-URL — the renderer reads its own identity,
   *  and it survives reload/restore for free), and tracks the window. */
  private spawn(desc: WindowDescriptor): ManagedWindow {
    let windowId = desc.windowId ?? windowIdOf(desc.url) ?? windowIdOf(desc.search);
    if (!windowId) {
      const base = desc.appId ?? desc.class;
      const live = new Set(this.open().map((w) => w.windowId));
      do {
        windowId = `${base}-${++this.idCounter}`;
      } while (live.has(windowId));
    }
    // ALWAYS stamp the id into `search`: the packaged-build entry path loads
    // `entry + search` (a restored `url` is only honored on the dev origin —
    // see main.ts `entryURL`), so `search` is the one slot that carries the id
    // in every mode. Idempotent when the restored URL already carried it.
    const params = new URLSearchParams(desc.search ?? "");
    params.set(WINDOW_ID_PARAM, windowId);
    return this.track(
      this.deps.spawn({ ...desc, search: "?" + params.toString(), windowId }),
    );
  }

  ensureWelcome(
    opts: {
      bounds?: WindowBounds;
      fullscreen?: boolean;
      maximized?: boolean;
      url?: string;
    } = {},
  ): ManagedWindow {
    const existing = this.byClass("welcome")[0];
    if (existing) {
      existing.focus();
      return existing;
    }
    return this.spawn({ class: "welcome", entry: entryFor("welcome"), ...opts });
  }

  openProfiler(opts: { bounds?: WindowBounds; url?: string } = {}): ManagedWindow {
    const existing = this.byClass("profiler")[0];
    if (existing) {
      existing.focus();
      return existing;
    }
    return this.spawn({ class: "profiler", entry: entryFor("profiler"), ...opts });
  }

  /**
   * Open a recorder viewer window for one `.fovea` file
   * (recorder-container.md §4). 0..N across files but ONE PER FILE — a
   * second open of the same path focuses the existing window. Never counted
   * for the welcome rule, never exclusive, never drained.
   */
  openViewer(
    path: string,
    opts: { bounds?: WindowBounds; url?: string } = {},
  ): ManagedWindow {
    const existing = this.byClass("viewer").find((w) => w.fileKey === path);
    if (existing) {
      existing.focus();
      return existing;
    }
    const search = "?" + new URLSearchParams({ path }).toString();
    return this.spawn({
      class: "viewer",
      entry: entryFor("viewer"),
      search,
      fileKey: path,
      ...opts,
    });
  }

  /**
   * Keyed toggle primitive (WS2 2a) — the reusable substrate for 2b's debug
   * drawer. The generalized form of `openViewer`'s dedupe, plus a close path:
   * if a window with `key` is already open, close it (toggle off) and return
   * null; otherwise spawn it (toggle on) and return the new window. The caller
   * supplies the full descriptor (class, entry, `owner`, …); `key` is stamped
   * on for the dedupe and cascade lifecycle.
   */
  toggle(key: string, desc: Omit<WindowDescriptor, "key">): ManagedWindow | null {
    const existing = this.open().find((w) => w.key === key);
    if (existing) {
      existing.close();
      return null;
    }
    return this.spawn({ ...desc, key });
  }

  /**
   * Toggle a module's `debug`-class sub-window (WS2 2b) — the FIRST
   * `owner`-setting caller of `toggle`, proving the 2a substrate end to end.
   * Owner-bound (`debug` is the sole `onOwnerClose: cascade` class): it tears
   * down when the opener app window closes or is switched away. The `session`
   * name + `kind` ride the URL (the mounted module component resolves its own
   * contract/pipes from them).
   *
   * `kind` (default `debugger`) selects WHICH module component the `debug`
   * host mounts (`debug-registry`), and — because it is part of the dedupe key
   * `debug:<session>:<kind>` — lets ONE session own more than one such window
   * at a time (its debugger AND its capture-preview, capture-recorder-nodes.md
   * ruling 8). Same session + same kind still dedupes to one window.
   */
  toggleDebug(
    session: string,
    owner: ManagedWindow | null,
    kind: string = "debugger",
  ): ManagedWindow | null {
    const search = "?" + new URLSearchParams({ session, kind }).toString();
    return this.toggle(`debug:${session}:${kind}`, {
      class: "debug",
      entry: entryFor("debug"),
      search,
      owner: owner ?? undefined,
    });
  }

  /**
   * OPEN-OR-FOCUS a module's `debug`-class sub-window (never closes) — the
   * idempotent sibling of `toggleDebug` for callers that must ENSURE the window
   * is up (capture-recorder-nodes.md ruling 8 / Phase 4: the capture / raster
   * buttons open the preview window after a shot without a second click
   * toggling it back shut). Same dedupe key + owner cascade as `toggleDebug`.
   */
  openDebug(
    session: string,
    owner: ManagedWindow | null,
    kind: string = "debugger",
  ): ManagedWindow {
    const key = `debug:${session}:${kind}`;
    const existing = this.open().find((w) => w.key === key);
    if (existing) {
      existing.focus();
      return existing;
    }
    const search = "?" + new URLSearchParams({ session, kind }).toString();
    return this.spawn({
      key,
      class: "debug",
      entry: entryFor("debug"),
      search,
      owner: owner ?? undefined,
    });
  }

  /**
   * Open a projection window for one stream (multi-window.md req. 4).
   * 0..N instances — never a singleton, never exclusive, never counted for
   * the welcome rule, never drained (passive subscriber), and deliberately
   * left open when its source app closes (§5.3 adopted default: frozen last
   * frame; the stream resumes if the topic comes back).
   */
  openProjection(
    params: ProjectionParams,
    opts: { bounds?: WindowBounds; url?: string } = {},
  ): ManagedWindow {
    const search =
      "?" +
      new URLSearchParams({ session: params.session, frame: params.frame }).toString();
    return this.spawn({
      class: "projection",
      entry: entryFor("projection"),
      search,
      ...opts,
    });
  }

  /**
   * Open (or switch to) an app window — the exclusivity + drain path.
   * Resolves once the switch completed (or was refused/skipped).
   */
  openApp(appId: string, opts: { bounds?: WindowBounds; url?: string } = {}): Promise<void> {
    const run = this.switching.then(() => this.openAppInner(appId, opts));
    // Keep the chain alive past failures so one bad switch doesn't wedge all
    // future ones.
    this.switching = run.catch(() => {});
    return run;
  }

  private async openAppInner(
    appId: string,
    opts: { bounds?: WindowBounds; url?: string },
  ): Promise<void> {
    const current = this.appWindow();
    if (current?.appId === appId) {
      current.focus();
      return;
    }
    this.inSwitch = true;
    try {
      const holders = [...this.byClass("app"), ...this.byClass("welcome")];
      // Switch inheritance: the new window lands on the same bounds and
      // full-screen/maximized state as the window it replaces (welcome→app
      // and app→app alike). Captured BEFORE close; explicit opts (manifest
      // restore) still win.
      const from = holders.find((w) => !w.isDestroyed());
      const inherit = from ? displayStateOf(from) : undefined;
      if (holders.length > 0) {
        // Drain first — the busy check must be able to refuse while the old
        // app is still intact ("closed" = drained, not window-destroyed).
        const drained = await this.deps.drainSessions();
        if (!drained.ok) {
          this.deps.notifyRefusal(drained.reason ?? "session busy");
          current?.focus();
          return;
        }
        for (const w of holders) if (!w.isDestroyed()) w.close();
      }
      this.spawn({
        class: "app",
        appId,
        entry: entryFor("app", appId),
        bounds: opts.bounds ?? inherit?.bounds,
        fullscreen: inherit?.fullscreen,
        maximized: inherit?.maximized,
        url: opts.url,
      });
    } finally {
      this.inSwitch = false;
    }
  }

  /** Snapshot every open window for the dev restart manifest. */
  collectManifest(): WindowManifest {
    return {
      version: 1,
      windows: this.open().map((w) => ({
        class: w.class,
        appId: w.appId,
        url: w.getURL(),
        bounds: w.getBounds(),
      })),
    };
  }

  /** Spawn a restore plan (already validated by `planFromManifest`). */
  async restore(plan: ManifestWindow[]): Promise<void> {
    for (const w of plan) {
      const opts = { bounds: w.bounds, url: w.url };
      switch (w.class) {
        case "welcome":
          this.ensureWelcome(opts);
          break;
        case "profiler":
          this.openProfiler(opts);
          break;
        case "app":
          if (w.appId) await this.openApp(w.appId, opts);
          break;
        case "projection": {
          // The stream address rides the persisted URL's query string —
          // re-derive `search` so the spawn works even where the full URL
          // isn't honored (entryURL only trusts same-origin dev URLs).
          this.spawn({
            class: "projection",
            entry: entryFor("projection"),
            search: searchOf(w.url),
            bounds: w.bounds,
            url: w.url,
          });
          break;
        }
        case "viewer": {
          // Same re-derivation; the `path` param doubles as the per-file
          // dedupe key, routed through openViewer so restore can't produce
          // two windows for one file.
          const search = searchOf(w.url);
          const path = search
            ? new URLSearchParams(search.slice(1)).get("path")
            : null;
          if (path) this.openViewer(path, { bounds: w.bounds, url: w.url });
          break;
        }
      }
    }
  }
}
