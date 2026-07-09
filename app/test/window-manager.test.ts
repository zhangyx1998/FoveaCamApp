// Main-process window state machine (A-6, docs/history/refactor/multi-window.md §3)
// exercised with fakes: a fake `spawn` (no BrowserWindow) and a fake
// session-drain hook. Covers the welcome rule, app exclusivity with
// drain-aware switching, busy refusal, the profiler singleton, and manifest
// collection.

import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOWS } from "@lib/windows";
import {
  WindowManager,
  type DrainResult,
  type ManagedWindow,
  type WindowDescriptor,
} from "../electron/window-manager";

class FakeWindow implements ManagedWindow {
  destroyed = false;
  focused = 0;
  onClosed: (() => void) | null = null;
  constructor(readonly desc: WindowDescriptor) {}
  get class() {
    return this.desc.class;
  }
  get appId() {
    return this.desc.appId;
  }
  get fileKey() {
    return this.desc.fileKey;
  }
  get owner() {
    return this.desc.owner;
  }
  get key() {
    return this.desc.key;
  }
  get windowId() {
    return this.desc.windowId;
  }
  focus() {
    this.focused++;
  }
  close() {
    // Mirrors BrowserWindow: close destroys, then fires "closed".
    this.destroyed = true;
    this.onClosed?.();
  }
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    // Mirrors a real window: state-in-URL params (desc.search) are part of
    // the landing URL the manifest snapshots.
    return `test://${this.desc.entry}${this.desc.search ?? ""}`;
  }
  getBounds() {
    return { x: 1, y: 2, width: 300, height: 200 };
  }
  // Switch-inheritance display state (mutable so tests can stage it).
  fullscreen = false;
  maximized = false;
  isFullScreen() {
    return this.fullscreen;
  }
  isMaximized() {
    return this.maximized;
  }
}

function harness(drainResult: DrainResult | (() => Promise<DrainResult>) = { ok: true }) {
  const spawned: FakeWindow[] = [];
  const refusals: string[] = [];
  const drain = vi.fn(async () =>
    typeof drainResult === "function" ? drainResult() : drainResult,
  );
  const manager = new WindowManager({
    spawn(desc) {
      const w = new FakeWindow(desc);
      // Wire the closed event the way main.ts does.
      w.onClosed = () => manager.onWindowClosed(w);
      spawned.push(w);
      return w;
    },
    drainSessions: drain,
    notifyRefusal: (reason) => refusals.push(reason),
  });
  return { manager, spawned, drain, refusals };
}

describe("WindowManager", () => {
  it("boots to welcome and focuses (not respawns) an existing welcome", () => {
    const { manager, spawned } = harness();
    const first = manager.ensureWelcome();
    const second = manager.ensureWelcome();
    expect(spawned.length).toBe(1);
    expect(first).toBe(second);
    expect((second as FakeWindow).focused).toBe(1);
  });

  it("opening an app from welcome drains, closes welcome, then spawns the app", async () => {
    const { manager, spawned, drain } = harness();
    const welcome = manager.ensureWelcome() as FakeWindow;
    await manager.openApp("manage-cameras");
    expect(drain).toHaveBeenCalledTimes(1); // welcome holds cameras (live previews)
    expect(welcome.destroyed).toBe(true); // adopted default 1: welcome closes on app open
    const app = manager.appWindow();
    expect(app?.appId).toBe("manage-cameras");
    expect(spawned.length).toBe(2);
  });

  it("opening the already-open app focuses it without draining", async () => {
    const { manager, drain, spawned } = harness();
    await manager.openApp("manage-cameras"); // no holders yet — spawns directly
    expect(drain).not.toHaveBeenCalled();
    await manager.openApp("manage-cameras");
    expect(drain).not.toHaveBeenCalled();
    expect(spawned.length).toBe(1);
    expect(spawned[0].focused).toBe(1);
  });

  it("switching apps drains A before B spawns (closed = drained, not destroyed)", async () => {
    const order: string[] = [];
    const { manager, spawned } = harness(async () => {
      order.push("drain");
      return { ok: true };
    });
    await manager.openApp("manage-cameras");
    const a = spawned[0];
    const origClose = a.close.bind(a);
    a.close = () => {
      order.push("close-A");
      origClose();
    };
    await manager.openApp("disparity-scope");
    order.push(`spawned:${manager.appWindow()?.appId}`);
    expect(order).toEqual(["drain", "close-A", "spawned:disparity-scope"]);
    expect(a.destroyed).toBe(true);
  });

  it("refuses the switch (keeping A) when the drain reports busy", async () => {
    const { manager, spawned, refusals } = harness({
      ok: false,
      reason: "manual-control: recording in progress",
    });
    await manager.openApp("manual-control");
    const a = spawned[0];
    await manager.openApp("disparity-scope");
    expect(refusals).toEqual(["manual-control: recording in progress"]);
    expect(a.destroyed).toBe(false); // A stays
    expect(manager.appWindow()?.appId).toBe("manual-control");
    expect(spawned.length).toBe(1); // B never spawned
  });

  it("welcome respawns when the last app window closes", async () => {
    const { manager, spawned } = harness();
    await manager.openApp("manage-cameras");
    (spawned[0] as FakeWindow).close(); // user closes the app window
    const welcome = manager.open().find((w) => w.class === "welcome");
    expect(welcome).toBeDefined();
  });

  // Switch inheritance (UX, 2026-07-08): the replacement window lands on the
  // same bounds + full-screen/maximized state as the window it replaces — in
  // BOTH directions (welcome→app at switch; app→welcome via the welcome rule,
  // answered from the adapter's last-known snapshot post-destroy).
  it("welcome→app switch inherits bounds + fullscreen from the welcome window", async () => {
    const { manager, spawned } = harness();
    const welcome = manager.ensureWelcome() as FakeWindow;
    welcome.fullscreen = true;
    await manager.openApp("manage-cameras");
    const app = spawned.find((w) => w.class === "app")!;
    expect(app.desc.bounds).toEqual(welcome.getBounds());
    expect(app.desc.fullscreen).toBe(true);
  });

  it("app→welcome respawn inherits the closed app window's display state", async () => {
    const { manager, spawned } = harness();
    await manager.openApp("manage-cameras");
    const app = spawned[0] as FakeWindow;
    app.maximized = true;
    app.close();
    const welcome = spawned.find((w) => w.class === "welcome")!;
    expect(welcome.desc.bounds).toEqual(app.getBounds());
    expect(welcome.desc.maximized).toBe(true);
  });

  it("closing the welcome window itself does not respawn it", () => {
    const { manager, spawned } = harness();
    manager.ensureWelcome();
    (spawned[0] as FakeWindow).close();
    expect(manager.open().length).toBe(0);
    expect(spawned.length).toBe(1);
  });

  it("does not respawn welcome for the app window closed mid-switch", async () => {
    const { manager, spawned } = harness();
    await manager.openApp("manage-cameras");
    await manager.openApp("disparity-scope"); // closes A mid-switch
    const classes = manager.open().map((w) => w.class);
    expect(classes).toEqual(["app"]); // no welcome sneaked in during the gap
    expect(spawned.filter((w) => w.class === "welcome").length).toBe(0);
  });

  it("profiler is a singleton and does not count toward the welcome rule", async () => {
    const { manager, spawned, drain } = harness();
    manager.openProfiler();
    manager.openProfiler();
    expect(spawned.filter((w) => w.class === "profiler").length).toBe(1);
    // Opening an app with only the profiler open needs no drain (profiler
    // is passive) — there are no camera-holding windows.
    await manager.openApp("manage-cameras");
    expect(drain).not.toHaveBeenCalled();
    // Closing the app respawns welcome even though the profiler stays open.
    manager.appWindow()!.close();
    expect(manager.open().map((w) => w.class).sort()).toEqual(["profiler", "welcome"]);
  });

  it("suppresses the welcome rule while quitting", async () => {
    const { manager, spawned } = harness();
    await manager.openApp("manage-cameras");
    manager.markQuitting();
    (spawned[0] as FakeWindow).close();
    expect(manager.open().length).toBe(0);
  });

  it("collects a manifest snapshot of every open window", async () => {
    const { manager } = harness();
    manager.openProfiler();
    await manager.openApp("manage-cameras");
    const manifest = manager.collectManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.windows.length).toBe(2);
    const appEntry = manifest.windows.find((w) => w.class === "app");
    expect(appEntry).toMatchObject({
      appId: "manage-cameras",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
    });
    // A-34: the landing URL carries the minted stable id.
    expect(appEntry!.url).toMatch(/^test:\/\/windows\/manage-cameras\.html\?win=manage-cameras-\d+$/);
  });

  it("restores a plan: app + profiler, bounds/url forwarded to spawn", async () => {
    const { manager, spawned } = harness();
    await manager.restore([
      { class: "profiler" },
      {
        class: "app",
        appId: "disparity-scope",
        url: "test://windows/disparity-scope.html",
        bounds: { x: 5, y: 6, width: 700, height: 500 },
      },
    ]);
    expect(spawned.map((w) => w.class).sort()).toEqual(["app", "profiler"]);
    const app = spawned.find((w) => w.class === "app")!;
    expect(app.desc.bounds).toEqual({ x: 5, y: 6, width: 700, height: 500 });
    expect(app.desc.url).toBe("test://windows/disparity-scope.html");
  });

  // --- projection windows (A-9, multi-window.md req. 4) -------------------

  it("allows multiple projection windows (0..N, never a singleton)", () => {
    const { manager, spawned } = harness();
    manager.openProjection({ session: "tracking", frame: "C" });
    manager.openProjection({ session: "tracking", frame: "C" }); // same stream twice is fine
    manager.openProjection({ session: "manual-control", frame: "L" });
    expect(spawned.filter((w) => w.class === "projection").length).toBe(3);
    expect(spawned[0].desc.search).toBe("?session=tracking&frame=C&win=projection-1");
    expect(spawned[2].desc.search).toBe("?session=manual-control&frame=L&win=projection-3");
  });

  it("projections don't count for the welcome rule and survive app close", async () => {
    const { manager, spawned } = harness();
    await manager.openApp("manual-control");
    const projection = manager.openProjection({ session: "tracking", frame: "C" }) as FakeWindow;
    // Closing the app respawns welcome even though a projection stays open…
    manager.appWindow()!.close();
    expect(manager.open().map((w) => w.class).sort()).toEqual(["projection", "welcome"]);
    expect(projection.destroyed).toBe(false); // §5.3: survives its source app's close
    // …and closing the projection itself never conjures anything.
    const before = spawned.length;
    projection.close();
    expect(spawned.length).toBe(before);
  });

  it("app switching neither drains nor closes projections", async () => {
    const { manager, spawned, drain } = harness();
    await manager.openApp("manual-control");
    const projection = manager.openProjection({ session: "tracking", frame: "C" }) as FakeWindow;
    drain.mockClear();
    await manager.openApp("disparity-scope");
    expect(drain).toHaveBeenCalledTimes(1); // the app drained…
    expect(projection.destroyed).toBe(false); // …the projection untouched
    expect(manager.appWindow()?.appId).toBe("disparity-scope");
  });

  it("manifest round-trips projections including their URL params", () => {
    const { manager } = harness();
    manager.openProjection({ session: "tracking", frame: "C" });
    manager.openProjection({ session: "manual-control", frame: "center" });
    const manifest = manager.collectManifest();
    const projections = manifest.windows.filter((w) => w.class === "projection");
    expect(projections.map((w) => w.url)).toEqual([
      "test://windows/projection.html?session=tracking&frame=C&win=projection-1",
      "test://windows/projection.html?session=manual-control&frame=center&win=projection-2",
    ]);
  });

  it("restore re-derives a projection's search params from its persisted URL", async () => {
    const { manager, spawned } = harness();
    await manager.restore([
      {
        class: "projection",
        url: "http://localhost:5173/windows/projection.html?session=tracking&frame=C",
        bounds: { x: 9, y: 9, width: 640, height: 480 },
      },
    ]);
    const w = spawned.find((s) => s.class === "projection")!;
    expect(w.desc.search).toBe("?session=tracking&frame=C&win=projection-1");
    expect(w.desc.bounds).toEqual({ x: 9, y: 9, width: 640, height: 480 });
  });

  // --- recorder viewer windows (A-11, recorder-container.md §4) -----------

  it("viewer windows: 0..N across files but exactly one per file", () => {
    const { manager, spawned } = harness();
    const first = manager.openViewer("/tmp/a.fovea") as FakeWindow;
    const again = manager.openViewer("/tmp/a.fovea") as FakeWindow; // same file → focus
    const other = manager.openViewer("/tmp/b.fovea") as FakeWindow;
    expect(spawned.filter((w) => w.class === "viewer").length).toBe(2);
    expect(again).toBe(first);
    expect(first.focused).toBe(1);
    expect(other).not.toBe(first);
    expect(first.desc.search).toBe("?path=%2Ftmp%2Fa.fovea&win=viewer-1");
    expect(first.desc.fileKey).toBe("/tmp/a.fovea");
  });

  it("closing a viewed file's window allows re-opening it fresh", () => {
    const { manager, spawned } = harness();
    const first = manager.openViewer("/tmp/a.fovea") as FakeWindow;
    first.close();
    const second = manager.openViewer("/tmp/a.fovea") as FakeWindow;
    expect(second).not.toBe(first);
    expect(spawned.length).toBe(2);
  });

  it("viewers don't count for the welcome rule and survive app switching", async () => {
    const { manager, spawned, drain } = harness();
    await manager.openApp("manual-control");
    const v = manager.openViewer("/tmp/a.fovea") as FakeWindow;
    await manager.openApp("disparity-scope"); // drain + switch
    expect(drain).toHaveBeenCalledTimes(1);
    expect(v.destroyed).toBe(false); // untouched by exclusivity
    manager.appWindow()!.close();
    expect(manager.open().map((w) => w.class).sort()).toEqual(["viewer", "welcome"]);
    // Closing the viewer itself conjures nothing.
    const before = spawned.length;
    v.close();
    expect(spawned.length).toBe(before);
  });

  it("manifest round-trips viewers; restore routes through the per-file dedupe", async () => {
    const { manager } = harness();
    manager.openViewer("/tmp/a.fovea");
    const manifest = manager.collectManifest();
    expect(manifest.windows[0]).toMatchObject({
      class: "viewer",
      url: "test://windows/viewer.html?path=%2Ftmp%2Fa.fovea&win=viewer-1",
    });
    // Restore a plan that (pathologically) lists the same file twice — the
    // dedupe holds because restore routes through openViewer.
    const fresh = harness();
    await fresh.manager.restore([
      { class: "viewer", url: "test://windows/viewer.html?path=%2Ftmp%2Fa.fovea" },
      { class: "viewer", url: "test://windows/viewer.html?path=%2Ftmp%2Fa.fovea" },
    ]);
    expect(fresh.spawned.filter((w) => w.class === "viewer").length).toBe(1);
    expect(fresh.spawned[0].desc.fileKey).toBe("/tmp/a.fovea");
  });

  // --- window-ownership foundation (WS2 2a) -------------------------------
  // No owner-setter ships until 2b, so these drive owned sub-windows through
  // the `toggle` opener (which accepts an `owner` in its descriptor).

  const child = (
    manager: WindowManager,
    key: string,
    owner: ManagedWindow,
  ): FakeWindow =>
    manager.toggle(key, {
      class: "projection",
      entry: "windows/projection.html",
      owner,
    }) as FakeWindow;

  it("childrenOf walks the windows owned by a parent", async () => {
    const { manager } = harness();
    await manager.openApp("manual-control");
    const app = manager.appWindow()!;
    const a = child(manager, "dbg:a", app);
    const b = child(manager, "dbg:b", app);
    const kids = manager.childrenOf(app);
    expect(kids).toHaveLength(2);
    expect(kids).toContain(a);
    expect(kids).toContain(b);
    expect(manager.childrenOf(a)).toEqual([]); // no grandchildren
  });

  it("survive-policy children stay open when their owner closes (default)", async () => {
    const { manager } = harness();
    await manager.openApp("manual-control");
    const app = manager.appWindow()! as FakeWindow;
    const c = child(manager, "proj", app); // projection = survive
    app.close();
    expect(c.destroyed).toBe(false);
  });

  it("cascade-policy children close with their owner (and grandchildren too)", async () => {
    // Temporarily make `projection` a cascade class (2b's debug drawer will be
    // the real cascade class); restored in afterEach below.
    WINDOWS.projection.onOwnerClose = "cascade";
    const { manager } = harness();
    await manager.openApp("manual-control");
    const app = manager.appWindow()! as FakeWindow;
    const c = child(manager, "dbg", app);
    const grandchild = child(manager, "dbg2", c); // owned by the child
    expect(c.destroyed).toBe(false);
    app.close();
    expect(c.destroyed).toBe(true); // cascaded with the app
    expect(grandchild.destroyed).toBe(true); // and the grandchild with it
  });

  it("toggle opens on first call and closes on the second (same key)", () => {
    const { manager, spawned } = harness();
    const w = manager.toggle("k", { class: "projection", entry: "e" }) as FakeWindow;
    expect(w).not.toBeNull();
    expect(spawned.length).toBe(1);
    expect(manager.toggle("k", { class: "projection", entry: "e" })).toBeNull();
    expect(w.destroyed).toBe(true);
  });

  it("toggle re-opens a fresh window after being toggled closed", () => {
    const { manager, spawned } = harness();
    manager.toggle("k", { class: "projection", entry: "e" });
    manager.toggle("k", { class: "projection", entry: "e" }); // close
    const again = manager.toggle("k", { class: "projection", entry: "e" });
    expect(again).not.toBeNull();
    expect(spawned.length).toBe(2); // dedupe held while open; two distinct spawns
  });

  // --- debug sub-window (WS2 2b, the FIRST real owner-setter) --------------

  it("toggleDebug opens a cascade-owned debug window keyed by session", async () => {
    const { manager } = harness();
    await manager.openApp("manual-control");
    const app = manager.appWindow()! as FakeWindow;
    const dbg = manager.toggleDebug("tracking", app) as FakeWindow;
    expect(dbg).not.toBeNull();
    expect(dbg.class).toBe("debug");
    expect(dbg.owner).toBe(app);
    expect(dbg.key).toBe("debug:tracking");
    expect(manager.childrenOf(app)).toContain(dbg);
    // The session name rides the URL; no `frame` arg any more (the module's
    // Debugger.vue resolves its own subscriptions from the session).
    const params = new URLSearchParams(dbg.desc.search);
    expect(params.get("session")).toBe("tracking");
    expect(params.has("frame")).toBe(false);
  });

  it("toggleDebug is a real toggle (second call on the same session closes it)", async () => {
    const { manager } = harness();
    await manager.openApp("manual-control");
    const app = manager.appWindow()!;
    const dbg = manager.toggleDebug("tracking", app) as FakeWindow;
    expect(manager.toggleDebug("tracking", app)).toBeNull();
    expect(dbg.destroyed).toBe(true);
  });

  it("the debug window cascade-closes when its owner app closes", async () => {
    const { manager } = harness();
    await manager.openApp("manual-control");
    const app = manager.appWindow()! as FakeWindow;
    const dbg = manager.toggleDebug("tracking", app) as FakeWindow;
    app.close();
    expect(dbg.destroyed).toBe(true); // debug is the cascade class
  });

  it("the debug window cascade-closes when its owner app is switched away", async () => {
    const { manager } = harness();
    await manager.openApp("manual-control");
    const app = manager.appWindow()! as FakeWindow;
    const dbg = manager.toggleDebug("tracking", app) as FakeWindow;
    await manager.openApp("disparity-scope"); // drains + closes the open app
    expect(dbg.destroyed).toBe(true);
    expect(manager.appWindow()?.appId).toBe("disparity-scope");
  });

  it("supports one debug window per session; all cascade with the owner app", async () => {
    const { manager } = harness();
    await manager.openApp("manual-control");
    const app = manager.appWindow()! as FakeWindow;
    const d1 = manager.toggleDebug("tracking", app) as FakeWindow;
    const d2 = manager.toggleDebug("manual-control", app) as FakeWindow;
    expect(d1).not.toBe(d2); // distinct keys ⇒ two windows
    expect(d1.key).toBe("debug:tracking");
    expect(d2.key).toBe("debug:manual-control");
    expect(manager.childrenOf(app)).toHaveLength(2);
    app.close();
    expect(d1.destroyed).toBe(true);
    expect(d2.destroyed).toBe(true);
  });

  it("toggleDebug with no app window spawns an ownerless (non-cascading) debug window", () => {
    // Defensive: no owner ⇒ nothing cascades it (it just lives until closed).
    const { manager } = harness();
    const dbg = manager.toggleDebug("tracking", null) as FakeWindow;
    expect(dbg).not.toBeNull();
    expect(dbg.owner).toBeUndefined();
  });
});

// Restore any per-test WINDOWS policy mutation (the cascade test flips
// `projection` to cascade) so class metadata stays pristine for other suites.
afterEach(() => {
  WINDOWS.projection.onOwnerClose = "survive";
});

describe("stable window identity (A-34)", () => {
  it("mints unique <appId|class>-<n> ids and stamps ?win= into the spawn search", async () => {
    const { manager, spawned } = harness();
    manager.ensureWelcome();
    await manager.openApp("manage-cameras");
    const [welcome, app] = spawned;
    expect(welcome.windowId).toBe("welcome-1");
    expect(app.windowId).toBe("manage-cameras-2");
    // The id rides the landing URL so the renderer can read its own identity.
    expect(new URLSearchParams(welcome.desc.search).get("win")).toBe("welcome-1");
    expect(new URLSearchParams(app.desc.search).get("win")).toBe("manage-cameras-2");
  });

  it("keeps existing state-in-URL params when stamping the id", () => {
    const { manager, spawned } = harness();
    manager.openProjection({ session: "tracking", frame: "C" });
    const params = new URLSearchParams(spawned[0].desc.search);
    expect(params.get("session")).toBe("tracking");
    expect(params.get("frame")).toBe("C");
    expect(params.get("win")).toBe("projection-1");
  });

  it("recovers a restored URL's id instead of re-minting, and dodges live collisions", () => {
    const { manager, spawned } = harness();
    // Manifest restore: the persisted URL carries the pre-restart id.
    manager.openProjection(
      { session: "tracking", frame: "C" },
      { url: "test://windows/projection.html?session=tracking&frame=C&win=projection-7" },
    );
    expect(spawned[0].windowId).toBe("projection-7");
    // Restored windows keep their ids; fresh mints must not collide with them.
    const fresh = manager.openProjection({ session: "t2", frame: "L" });
    expect(fresh.windowId).not.toBe("projection-7");
    expect(new Set(manager.open().map((w) => w.windowId)).size).toBe(2);
  });

  it("distinct live windows never share an id", () => {
    const { manager } = harness();
    manager.openProjection({ session: "a", frame: "C" });
    manager.openProjection({ session: "b", frame: "C" });
    manager.openViewer("/tmp/x.fovea");
    const ids = manager.open().map((w) => w.windowId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
