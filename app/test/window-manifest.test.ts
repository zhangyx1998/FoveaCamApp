// Window manifest persist/consume + restore-plan logic (A-6, docs/history/refactor/
// multi-window.md req. 6 / §4): the dev-restart flow's state carrier.

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeManifest,
  manifestPath,
  planFromManifest,
  saveManifest,
  type WindowManifest,
} from "../electron/window-manifest";

const tmpDirs: string[] = [];
function tmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fovea-manifest-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("saveManifest / consumeManifest", () => {
  it("round-trips a manifest and deletes it on consume (one-shot)", async () => {
    const dir = tmpDataDir();
    const manifest: WindowManifest = {
      version: 1,
      windows: [
        { class: "app", appId: "disparity-scope", url: "u", bounds: { x: 1, y: 2, width: 3, height: 4 } },
        { class: "profiler" },
      ],
    };
    await saveManifest(dir, manifest);
    expect(existsSync(manifestPath(dir))).toBe(true);

    const loaded = await consumeManifest(dir);
    expect(loaded).toEqual(manifest);
    // One-shot: consumed = deleted, the next boot gets the default layout.
    expect(existsSync(manifestPath(dir))).toBe(false);
    expect(await consumeManifest(dir)).toBeNull();
  });

  it("returns null (and clears the file) on unreadable content", async () => {
    const dir = tmpDataDir();
    await saveManifest(dir, { version: 1, windows: [] });
    const fs = await import("node:fs/promises");
    await fs.writeFile(manifestPath(dir), "{not json");
    expect(await consumeManifest(dir)).toBeNull();
    expect(existsSync(manifestPath(dir))).toBe(false);
  });
});

describe("planFromManifest", () => {
  it("falls back to welcome for a missing/empty manifest", () => {
    expect(planFromManifest(null)).toEqual([{ class: "welcome" }]);
    expect(planFromManifest({ version: 1, windows: [] })).toEqual([
      { class: "welcome" },
    ]);
  });

  it("enforces app exclusivity: first valid app wins, welcome suppressed", () => {
    const plan = planFromManifest({
      version: 1,
      windows: [
        { class: "welcome" },
        { class: "app", appId: "manage-cameras" },
        { class: "app", appId: "disparity-scope" }, // second app dropped
      ],
    });
    expect(plan).toEqual([{ class: "app", appId: "manage-cameras" }]);
  });

  it("drops unknown classes and unknown app ids; welcome joins utility-only plans", () => {
    const plan = planFromManifest({
      version: 1,
      windows: [
        { class: "hologram" as never }, // future taxonomy — not spawnable yet
        { class: "app", appId: "not-a-real-app" },
        { class: "profiler" },
      ],
    });
    // No app and no welcome persisted → welcome is prepended (the welcome
    // rule holds at restore time too: utility windows don't count).
    expect(plan).toEqual([{ class: "welcome" }, { class: "profiler" }]);
  });

  it("keeps 0..N projections (never deduped), with their urls", () => {
    const p1 = {
      class: "projection" as const,
      url: "test://windows/projection.html?session=tracking&frame=C",
    };
    const p2 = {
      class: "projection" as const,
      url: "test://windows/projection.html?session=manual-control&frame=L",
    };
    const plan = planFromManifest({
      version: 1,
      windows: [p1, { class: "app", appId: "disparity-scope" }, p2],
    });
    expect(plan).toEqual([p1, { class: "app", appId: "disparity-scope" }, p2]);
  });

  it("keeps 0..N viewers (per-file dedupe is openViewer's job, not the plan's)", () => {
    const v1 = { class: "viewer" as const, url: "test://windows/viewer.html?path=%2Fa.fovea" };
    const v2 = { class: "viewer" as const, url: "test://windows/viewer.html?path=%2Fb.fovea" };
    const plan = planFromManifest({
      version: 1,
      windows: [v1, { class: "app", appId: "disparity-scope" }, v2],
    });
    expect(plan).toEqual([v1, { class: "app", appId: "disparity-scope" }, v2]);
  });

  it("projections alone still get a welcome (they don't count for the rule)", () => {
    const plan = planFromManifest({
      version: 1,
      windows: [
        { class: "projection", url: "test://windows/projection.html?session=a&frame=b" },
      ],
    });
    expect(plan[0]).toEqual({ class: "welcome" });
    expect(plan[1]?.class).toBe("projection");
  });

  it("dedupes welcome/profiler singletons and keeps profiler beside an app", () => {
    const plan = planFromManifest({
      version: 1,
      windows: [
        { class: "profiler" },
        { class: "profiler" },
        { class: "app", appId: "disparity-scope" },
      ],
    });
    expect(plan).toEqual([
      { class: "profiler" },
      { class: "app", appId: "disparity-scope" },
    ]);
  });

  // --- owner-bound (cascade) windows don't restore (WS2 2b) ---------------

  it("drops cascade (owner-bound) windows on restore beside their app", () => {
    // A `debug` sub-window can't reattach to an owner across a restart (the
    // owner pointer isn't persisted) — planFromManifest drops it.
    const plan = planFromManifest({
      version: 1,
      windows: [
        { class: "app", appId: "disparity-scope" },
        { class: "debug", url: "test://windows/debug.html?session=tracking&frame=C" },
      ],
    });
    expect(plan.map((w) => w.class)).toEqual(["app"]);
  });

  it("a debug-only manifest restores to just welcome (debug dropped, doesn't count)", () => {
    const plan = planFromManifest({
      version: 1,
      windows: [
        { class: "debug", url: "test://windows/debug.html?session=tracking&frame=C" },
      ],
    });
    expect(plan).toEqual([{ class: "welcome" }]);
  });
});
