// Coverage for the config window's calibration-data enumeration + friendly
// naming + triple-config merge (`@lib/calibration-data`). Uses an in-memory
// fake `CalStore` (no orchestrator / disk). Triple friendly-name resolution is
// exercised against the SAME `tripleHash` the enumeration compares to, so a
// drift between `tripleHash` and `orchestrator/calibration.ts`'s
// `tripleConfigPath` would surface here.

import { describe, expect, it } from "vitest";
import { getCameraKey } from "@lib/camera-config";
import {
  enumerateCalibrationData,
  deleteCalibrationEntry,
  cameraLabel,
  tripleLabel,
  tripleHash,
  mergeTripleConfig,
  type CalStore,
  type KnownCamera,
} from "@lib/calibration-data";

function fakeStore(seed: Record<string, unknown> = {}) {
  const disk = new Map<string, unknown>(Object.entries(seed));
  const keyOf = (segs: string | string[]) =>
    (Array.isArray(segs) ? segs : [segs]).join("/");
  const store: CalStore & { disk: Map<string, unknown> } = {
    disk,
    async list(...segments) {
      const prefix = segments.join("/") + "/";
      const names = new Set<string>();
      for (const k of disk.keys())
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length));
      return [...names];
    },
    async read(segments, fallback) {
      const k = keyOf(segments);
      return (disk.has(k) ? disk.get(k) : fallback) as any;
    },
    async clear(...segments) {
      disk.delete(keyOf(segments));
    },
  };
  return store;
}

const camL: KnownCamera = { vendor: "FLIR", model: "BFS", serial: "L001", role: "L" };
const camC: KnownCamera = { vendor: "FLIR", model: "BFS", serial: "C002", role: "C" };
const camR: KnownCamera = { vendor: "FLIR", model: "BFS", serial: "R003", role: "R" };

describe("cameraLabel", () => {
  it("resolves a friendly name (with role) from a known camera", () => {
    const key = getCameraKey(camL);
    expect(cameraLabel(key, [camL, camC, camR])).toBe("FLIR BFS (L001) · Left Fovea");
  });
  it("falls back to the raw key for an unknown device", () => {
    expect(cameraLabel("Some_Unknown_Key", [camL])).toBe("Some_Unknown_Key");
  });
});

describe("tripleLabel", () => {
  it("names a triple whose hash reconstructs from known cameras", async () => {
    const hash = await tripleHash({
      L: getCameraKey(camL),
      C: getCameraKey(camC),
      R: getCameraKey(camR),
    });
    expect(await tripleLabel(hash, [camL, camC, camR])).toBe("L001 / C002 / R003");
  });
  it("falls back to a short hash when cameras don't reconstruct it", async () => {
    const hash = "abcdef0123456789abcdef";
    expect(await tripleLabel(hash, [camL, camC, camR])).toBe("abcdef0123…");
  });
});

describe("enumerateCalibrationData", () => {
  it("enumerates all three categories with metadata + friendly names", async () => {
    const hash = await tripleHash({
      L: getCameraKey(camL),
      C: getCameraKey(camC),
      R: getCameraKey(camR),
    });
    const store = fakeStore({
      [`calibrate-intrinsic/${getCameraKey(camC)}`]: {
        rvecs: [1, 2, 3],
        rms: 0.312,
        date: new Date("2026-07-01T00:00:00Z"),
      },
      [`calibrate-extrinsic/${getCameraKey(camL)}`]: [{}, {}, {}, {}],
      [`triples/${hash}`]: { drift_l: 1, drift_r: 2, zoom_override: 3.5 },
    });

    const entries = await enumerateCalibrationData(store, [camL, camC, camR]);
    expect(entries).toHaveLength(3);

    const tri = entries.find((e) => e.category === "triples")!;
    expect(tri.label).toBe("L001 / C002 / R003");
    expect(tri.detail).toContain("drift");
    expect(tri.detail).toContain("zoom 3.50×");

    const intr = entries.find((e) => e.category === "calibrate-intrinsic")!;
    expect(intr.label).toBe("FLIR BFS (C002) · Center Wide");
    expect(intr.detail).toContain("3 views");
    expect(intr.detail).toContain("RMS 0.312");
    expect(intr.detail).toContain("2026-07-01");

    const extr = entries.find((e) => e.category === "calibrate-extrinsic")!;
    expect(extr.detail).toBe("4 samples");
  });

  it("delete removes exactly the targeted document", async () => {
    const store = fakeStore({
      [`calibrate-intrinsic/${getCameraKey(camC)}`]: { rvecs: [] },
      [`calibrate-extrinsic/${getCameraKey(camL)}`]: [],
    });
    const entries = await enumerateCalibrationData(store, [camC, camL]);
    const target = entries.find((e) => e.category === "calibrate-intrinsic")!;
    await deleteCalibrationEntry(store, target);
    const after = await enumerateCalibrationData(store, [camC, camL]);
    expect(after.map((e) => e.category)).toEqual(["calibrate-extrinsic"]);
  });
});

describe("mergeTripleConfig", () => {
  it("adds zoom_override WITHOUT clobbering drift or unknown fields", () => {
    const existing = { drift_l: 0.1, drift_r: -0.2, some_future_field: 7 };
    const merged = mergeTripleConfig(existing, { zoom_override: 2.5 });
    expect(merged).toEqual({
      drift_l: 0.1,
      drift_r: -0.2,
      some_future_field: 7,
      zoom_override: 2.5,
    });
  });

  it("read → merge → write round-trips, preserving drift", async () => {
    const hash = "deadbeef";
    const store = fakeStore({ [`triples/${hash}`]: { drift_l: 0.5, drift_r: 0.6 } });
    const existing = await store.read<Record<string, unknown>>(["triples", hash], {});
    const merged = mergeTripleConfig(existing, { zoom_override: 4 });
    (store as any).disk.set(`triples/${hash}`, merged);
    const back = await store.read<Record<string, unknown>>(["triples", hash], {});
    expect(back).toEqual({ drift_l: 0.5, drift_r: 0.6, zoom_override: 4 });
  });

  it("an undefined patch value CLEARS the field", () => {
    const merged = mergeTripleConfig(
      { drift_l: 1, zoom_override: 2 },
      { zoom_override: undefined },
    );
    expect(merged).toEqual({ drift_l: 1 });
    expect("zoom_override" in merged).toBe(false);
  });
});
