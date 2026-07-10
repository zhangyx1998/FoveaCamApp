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
  resolveBaseline,
  connectedTripleHash,
  orderTriples,
  defaultTripleSelection,
  DEFAULT_BASELINE_MM,
  type CalStore,
  type CalEntry,
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

    // Signed delay-compensation flag renders with an explicit +/- sign.
    const withDelay = await enumerateCalibrationData(
      fakeStore({ [`triples/${hash}`]: { delay_compensation_ms: -8 } }),
      [camL, camC, camR],
    );
    expect(withDelay[0].detail).toContain("delay -8.0 ms");
    const withLead = await enumerateCalibrationData(
      fakeStore({ [`triples/${hash}`]: { delay_compensation_ms: 12.5 } }),
      [camL, camC, camR],
    );
    expect(withLead[0].detail).toContain("delay +12.5 ms");

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

  it("round-trips ALL fields, preserving baseline_mm alongside drift + zoom", () => {
    const existing = {
      drift_l: 0.1,
      drift_r: -0.2,
      zoom_override: 3,
      baseline_mm: 175,
      some_future_field: 7,
    };
    // A no-op-shaped patch (re-writing baseline) must keep everything else.
    const merged = mergeTripleConfig(existing, { baseline_mm: 250 });
    expect(merged).toEqual({
      drift_l: 0.1,
      drift_r: -0.2,
      zoom_override: 3,
      baseline_mm: 250,
      some_future_field: 7,
    });
    // Clearing baseline leaves the rest intact.
    const cleared = mergeTripleConfig(merged, { baseline_mm: undefined });
    expect("baseline_mm" in cleared).toBe(false);
    expect(cleared).toMatchObject({ drift_l: 0.1, zoom_override: 3, some_future_field: 7 });
  });
});

describe("resolveBaseline (ruled order — triple > legacy app > 200)", () => {
  it("prefers the per-triple baseline when it is finite and > 0", () => {
    expect(resolveBaseline(175, 200)).toBe(175);
    expect(resolveBaseline(300, undefined)).toBe(300);
    // Triple wins even over a different legacy value.
    expect(resolveBaseline(120, 200)).toBe(120);
  });

  it("falls back to the legacy app value when the triple has none", () => {
    expect(resolveBaseline(undefined, 200)).toBe(200);
    expect(resolveBaseline(null, 240)).toBe(240);
    // A degenerate triple value (0 / NaN / negative) is rejected → legacy.
    expect(resolveBaseline(0, 220)).toBe(220);
    expect(resolveBaseline(-5, 220)).toBe(220);
    expect(resolveBaseline(NaN, 220)).toBe(220);
    expect(resolveBaseline(Infinity, 220)).toBe(220);
  });

  it("falls back to 200 when neither tier supplies a valid value", () => {
    expect(resolveBaseline(undefined, undefined)).toBe(DEFAULT_BASELINE_MM);
    expect(resolveBaseline(undefined, undefined)).toBe(200);
    // A degenerate legacy value is rejected too → the 200 default.
    expect(resolveBaseline(undefined, 0)).toBe(200);
    expect(resolveBaseline(0, -1)).toBe(200);
    expect(resolveBaseline(NaN, NaN)).toBe(200);
  });

  it("existing rigs (legacy 200, no triple field) keep the 200 baseline", () => {
    expect(resolveBaseline(undefined, 200)).toBe(200);
  });
});

// ---- Device-config triple selector (connected-first ordering + default) -----

const triEntry = (key: string, label = key): CalEntry => ({
  category: "triples",
  key,
  label,
  detail: "no overrides",
});

describe("connectedTripleHash", () => {
  it("hashes the connected L/C/R rig (matches tripleHash)", async () => {
    const expected = await tripleHash({
      L: getCameraKey(camL),
      C: getCameraKey(camC),
      R: getCameraKey(camR),
    });
    expect(await connectedTripleHash([camL, camC, camR])).toBe(expected);
  });
  it("is null when the role set is incomplete (no rig / partial)", async () => {
    expect(await connectedTripleHash([camL, camC])).toBeNull();
    expect(await connectedTripleHash([])).toBeNull();
  });
});

describe("orderTriples (connected first, else enumeration order)", () => {
  it("floats the connected triple to the front, preserving the rest", () => {
    const entries = [
      triEntry("aaa"),
      triEntry("bbb"),
      triEntry("ccc"),
      { category: "calibrate-intrinsic", key: "x", label: "x", detail: "" } as CalEntry,
    ];
    const ordered = orderTriples(entries, "ccc");
    expect(ordered.map((t) => t.key)).toEqual(["ccc", "aaa", "bbb"]);
    expect(ordered[0].connected).toBe(true);
    expect(ordered[1].connected).toBe(false);
  });
  it("keeps the enumeration order when nothing is connected", () => {
    const ordered = orderTriples([triEntry("aaa"), triEntry("bbb")], null);
    expect(ordered.map((t) => t.key)).toEqual(["aaa", "bbb"]);
    expect(ordered.every((t) => !t.connected)).toBe(true);
  });
});

describe("defaultTripleSelection", () => {
  it("selects the connected triple when present", () => {
    const ordered = orderTriples([triEntry("aaa"), triEntry("bbb")], "bbb");
    expect(defaultTripleSelection(ordered)?.key).toBe("bbb");
    expect(defaultTripleSelection(ordered)?.connected).toBe(true);
  });
  it("falls back to the first triple (not connected) when no rig matches", () => {
    const ordered = orderTriples([triEntry("aaa"), triEntry("bbb")], null);
    const sel = defaultTripleSelection(ordered);
    expect(sel?.key).toBe("aaa");
    expect(sel?.connected).toBe(false); // UI shows a "not connected" state
  });
  it("is null when no triples are configured", () => {
    expect(defaultTripleSelection(orderTriples([], null))).toBeNull();
  });
});
