// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Window manifest for the dev-mode full-restart refresh (docs/refactor/
// multi-window.md req. 6 / §4): Ctrl/Cmd-Shift-R persists {class, landing
// URL, bounds} for every open window, relaunches the whole app (main +
// orchestrator), and startup consumes the manifest to restore the exact
// pre-refresh layout.
//
// Persistence rides the store's file layout (`<userData>/store/
// window-manifest.json`, atomic temp+rename, same `store-codec`), but is
// read/written by the MAIN process directly rather than through the
// orchestrator store-hub: at persist time the orchestrator is about to be
// killed, and at consume time it may not have booted yet — the store-hub
// round-trip doesn't exist at either end of the restart.
//
// `planFromManifest` (pure, unit-tested) turns a loaded manifest into the
// spawn plan, enforcing the same invariants the window manager enforces
// live: at most one app window, welcome/profiler singletons, unknown
// classes/apps dropped, and the welcome fallback when nothing valid remains.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replacer, reviver } from "@lib/store-codec";
import { appById, type WindowClass } from "@lib/windows";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ManifestWindow {
  class: WindowClass;
  /** App id for `class: "app"` windows. */
  appId?: string;
  /** Full landing URL (includes any state subpath — multi-window.md req. 7). */
  url?: string;
  bounds?: WindowBounds;
}

export interface WindowManifest {
  version: 1;
  windows: ManifestWindow[];
}

export function manifestPath(dataDir: string): string {
  return join(dataDir, "store", "window-manifest.json");
}

/** Validate + normalize a (possibly hand-edited or stale) manifest into a
 *  spawn plan. Pure — unit-tested in `test/window-manifest.test.ts`. */
export function planFromManifest(
  manifest: WindowManifest | null | undefined,
): ManifestWindow[] {
  const plan: ManifestWindow[] = [];
  let haveApp = false;
  let haveWelcome = false;
  let haveProfiler = false;
  for (const w of manifest?.windows ?? []) {
    if (!w || typeof w !== "object") continue;
    switch (w.class) {
      case "app":
        // Exclusivity: at most one app window, first valid one wins.
        if (haveApp || !w.appId || !appById(w.appId)) continue;
        haveApp = true;
        plan.push(w);
        break;
      case "welcome":
        if (haveWelcome) continue;
        haveWelcome = true;
        plan.push(w);
        break;
      case "profiler":
        if (haveProfiler) continue;
        haveProfiler = true;
        plan.push(w);
        break;
      case "projection":
        // 0..N — projections are never singletons and never exclusive
        // (multi-window.md req. 4); their stream address rides `url`.
        plan.push(w);
        break;
      default:
        continue; // unknown class (future taxonomy) — drop
    }
  }
  // Welcome rule at restore time: an app window suppresses welcome; nothing
  // needing a fallback (no app AND no welcome — projections/profiler are
  // utility windows and don't count) boots the default welcome.
  if (haveApp) return plan.filter((w) => w.class !== "welcome");
  if (!haveWelcome) plan.unshift({ class: "welcome" });
  return plan;
}

/** Persist the manifest (atomic write, store file layout). */
export async function saveManifest(
  dataDir: string,
  manifest: WindowManifest,
): Promise<void> {
  const path = manifestPath(dataDir);
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, replacer, 2));
  await rename(tmp, path);
}

/** One-shot read: load the manifest and delete it, so a crash after restore
 *  (or a plain next launch) boots the default layout instead of replaying a
 *  stale one. Returns null when absent/unreadable. */
export async function consumeManifest(
  dataDir: string,
): Promise<WindowManifest | null> {
  const path = manifestPath(dataDir);
  if (!existsSync(path)) return null;
  let manifest: WindowManifest | null = null;
  try {
    const text = (await readFile(path)).toString();
    if (text.trim() !== "") manifest = JSON.parse(text, reviver) as WindowManifest;
  } catch (error) {
    process.stderr.write(`Error loading window manifest: ${error}\n`);
  }
  await rm(path, { force: true });
  return manifest;
}
