// Main-process window state machine (A-6, docs/refactor/multi-window.md §3)
// exercised with fakes: a fake `spawn` (no BrowserWindow) and a fake
// session-drain hook. Covers the welcome rule, app exclusivity with
// drain-aware switching, busy refusal, the profiler singleton, and manifest
// collection.

import { describe, expect, it, vi } from "vitest";
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
      url: "test://windows/manage-cameras.html",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
    });
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
    expect(spawned[0].desc.search).toBe("?session=tracking&frame=C");
    expect(spawned[2].desc.search).toBe("?session=manual-control&frame=L");
  });

  it("projections don't count for the welcome rule and survive app close", async () => {
    const { manager, spawned } = harness();
    await manager.openApp("tracking-single");
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
    await manager.openApp("tracking-single");
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
      "test://windows/projection.html?session=tracking&frame=C",
      "test://windows/projection.html?session=manual-control&frame=center",
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
    expect(w.desc.search).toBe("?session=tracking&frame=C");
    expect(w.desc.bounds).toEqual({ x: 9, y: 9, width: 640, height: 480 });
  });
});
