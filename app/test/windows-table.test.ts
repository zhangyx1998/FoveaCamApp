// Coverage for the `WINDOWS` taxonomy table (A-P8) — the single source the
// launcher, window manager, options adapter, manifest planner, and vite entry
// build all derive from. These assertions pin the invariants a new window
// class must satisfy so it can't silently miss one across those consumers.

import { describe, expect, it } from "vitest";
import {
  APPS,
  WINDOWS,
  allEntries,
  entryFor,
  type WindowClass,
} from "@lib/windows";

const CLASSES: WindowClass[] = [
  "welcome",
  "app",
  "profiler",
  "projection",
  "viewer",
  "debug",
];

describe("WINDOWS taxonomy table", () => {
  it("has exactly one row per window class", () => {
    expect(Object.keys(WINDOWS).sort()).toEqual([...CLASSES].sort());
  });

  it("keeps the exclusivity / welcome-rule invariants (app only)", () => {
    for (const cls of CLASSES) {
      const isApp = cls === "app";
      expect(WINDOWS[cls].exclusive).toBe(isApp);
      expect(WINDOWS[cls].countsForWelcome).toBe(isApp);
    }
  });

  it("marks welcome + profiler as the singletons, nothing else", () => {
    for (const cls of CLASSES)
      expect(WINDOWS[cls].singleton).toBe(cls === "welcome" || cls === "profiler");
  });

  it("dedupes only the viewer, by fileKey", () => {
    for (const cls of CLASSES)
      expect(WINDOWS[cls].dedupe).toBe(cls === "viewer" ? "fileKey" : undefined);
  });

  it("only the debug class cascades on owner close; the rest survive", () => {
    // WS2 2b: `debug` is the first (and only) cascade class — it closes with the
    // app that owns it. Every other class survives its owner's close.
    for (const cls of CLASSES) {
      expect(["cascade", "survive"]).toContain(WINDOWS[cls].onOwnerClose);
      expect(WINDOWS[cls].onOwnerClose).toBe(cls === "debug" ? "cascade" : "survive");
    }
  });

  it("pairs the sandboxed preload with the profiler and the reader preload elsewhere", () => {
    for (const cls of CLASSES) {
      const spec = WINDOWS[cls];
      expect(["renderer", "profiler"]).toContain(spec.preload);
      // profiler is the only sandboxed class; sandbox ⇔ bridge-only preload.
      expect(spec.sandbox).toBe(cls === "profiler");
      expect(spec.preload === "profiler").toBe(spec.sandbox);
    }
  });

  it("gives every class positive default bounds", () => {
    for (const cls of CLASSES) {
      const { width, height, minWidth, minHeight } = WINDOWS[cls].bounds;
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      if (minWidth !== undefined) expect(width).toBeGreaterThanOrEqual(minWidth);
      if (minHeight !== undefined) expect(height).toBeGreaterThanOrEqual(minHeight);
    }
  });

  it("gives every non-app class a static entry; app derives per id", () => {
    for (const cls of CLASSES) {
      if (cls === "app") expect(WINDOWS[cls].entry).toBeUndefined();
      else expect(WINDOWS[cls].entry).toMatch(/^windows\/[\w-]+\.html$/);
    }
  });

  it("entryFor derives from the table (static classes) and per app id", () => {
    expect(entryFor("welcome")).toBe(WINDOWS.welcome.entry);
    expect(entryFor("profiler")).toBe(WINDOWS.profiler.entry);
    expect(entryFor("viewer")).toBe(WINDOWS.viewer.entry);
    expect(entryFor("app", "disparity-scope")).toBe("windows/disparity-scope.html");
    expect(() => entryFor("app", "not-a-real-app")).toThrow();
  });

  it("allEntries emits every static class entry plus one per app", () => {
    const entries = allEntries();
    for (const cls of CLASSES) {
      const spec = WINDOWS[cls];
      if (spec.entry) expect(entries[cls]).toBe(spec.entry);
    }
    for (const app of APPS) expect(entries[app.id]).toBe(`windows/${app.id}.html`);
    // 4 static class entries (all but app) + one per app, no extras.
    expect(Object.keys(entries).length).toBe(5 + APPS.length);
  });
});
