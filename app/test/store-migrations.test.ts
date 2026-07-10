// Coverage for the store-schema migration framework (`@lib/store-migrations`):
// version detection, ordered application, idempotency (run twice = no-op),
// snapshot-hook decision logic, and legacy-fixture 0→1 correctness (a real
// store-file shape wrapped as content-hashed records with the legacy doc moved
// out of the tree). Uses an in-memory `MigrationFs` fake — no disk, no git.

import { describe, expect, it, vi } from "vitest";
import {
  MIGRATIONS,
  SCHEMA_DOC,
  STORE_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
  type MigrationFs,
} from "@lib/store-migrations";
import {
  RECORD_STORE,
  recordId,
  extrinsicInner,
  type CalibrationRecord,
} from "@lib/calibration-records";
import type { ExtrinsicData } from "@lib/camera-config";

/** A real-shaped extrinsic datapoint (mirrors the on-disk store file). */
const legacyDatapoint = (seed: number): ExtrinsicData => ({
  img_points: [
    { x: 476.58 + seed, y: 295.87 },
    { x: 962.64 + seed, y: 295.89 },
    { x: 963.19 + seed, y: 782.92 },
    { x: 476.88 + seed, y: 784.27 },
  ],
  obj_points: [
    { x: -0.5, y: -0.5, z: 0 },
    { x: 0.5, y: -0.5, z: 0 },
    { x: 0.5, y: 0.5, z: 0 },
    { x: -0.5, y: 0.5, z: 0 },
  ],
  voltage: { x: 1.2, y: -0.3 },
  angle: { x: 0.01, y: 0.02 },
});

const legacyDataset = (n: number) =>
  Array.from({ length: n }, (_, i) => legacyDatapoint(i));

function fakeFs(seed: Record<string, unknown> = {}) {
  const disk = new Map<string, unknown>(Object.entries(seed));
  const mtimes = new Map<string, number>();
  const keyOf = (segs: string[]) => segs.join("/");
  const fs: MigrationFs & { disk: Map<string, unknown>; setMtime(k: string, ms: number): void } = {
    disk,
    setMtime: (k, ms) => mtimes.set(k, ms),
    async read(segments, fallback) {
      const k = keyOf(segments);
      return (disk.has(k) ? disk.get(k) : fallback) as any;
    },
    async write(segments, value) {
      disk.set(keyOf(segments), value);
    },
    async clear(segments) {
      disk.delete(keyOf(segments));
    },
    async list(...segments) {
      const prefix = segments.join("/") + "/";
      const names = new Set<string>();
      for (const k of disk.keys())
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length));
      return [...names];
    },
    async stat(segments) {
      const k = keyOf(segments);
      return mtimes.has(k) ? { mtimeMs: mtimes.get(k)! } : null;
    },
  };
  return fs;
}

const ctx = { now: () => "2026-07-10T00:00:00.000Z" };

describe("version detection", () => {
  it("an unversioned tree reads as version 0", async () => {
    expect(await readSchemaVersion(fakeFs())).toBe(0);
  });
  it("reads a written version", async () => {
    const fs = fakeFs({ [SCHEMA_DOC.join("/")]: { version: 1 } });
    expect(await readSchemaVersion(fs)).toBe(1);
  });
});

describe("registry shape", () => {
  it("is a contiguous ordered chain up to STORE_SCHEMA_VERSION", () => {
    let v = 0;
    for (const m of [...MIGRATIONS].sort((a, b) => a.from - b.from)) {
      expect(m.from).toBe(v);
      expect(m.to).toBe(v + 1);
      v = m.to;
    }
    expect(v).toBe(STORE_SCHEMA_VERSION);
  });
});

describe("migration 0 → 1 (calibration-records-v2)", () => {
  it("wraps every legacy extrinsic doc as a record and moves the layout", async () => {
    const fs = fakeFs({
      "calibrate-extrinsic/CAM_L": legacyDataset(3),
      "calibrate-extrinsic/CAM_R": legacyDataset(4),
      // Analysis artifact — must be left verbatim.
      "calibrate-extrinsic/CAM_L.raw": legacyDataset(9),
    });
    fs.setMtime("calibrate-extrinsic/CAM_L", Date.parse("2026-06-01T00:00:00.000Z"));

    const res = await runMigrations(fs, { ctx });
    expect(res.from).toBe(0);
    expect(res.to).toBe(1);
    expect(res.applied).toEqual(["calibration-records-v2"]);
    expect(res.reports["calibration-records-v2"]).toMatchObject({ created: 2, skipped: 1 });

    // Legacy docs moved out; the .raw artifact stays.
    expect(fs.disk.has("calibrate-extrinsic/CAM_L")).toBe(false);
    expect(fs.disk.has("calibrate-extrinsic/CAM_R")).toBe(false);
    expect(fs.disk.has("calibrate-extrinsic/CAM_L.raw")).toBe(true);

    // Each record persisted under its content-hash id, with a cameraKey binding.
    const lId = await recordId(extrinsicInner(legacyDataset(3)));
    const rec = fs.disk.get(`${RECORD_STORE}/${lId}`) as CalibrationRecord;
    expect(rec.id).toBe(lId);
    expect(rec.inner.dataset).toHaveLength(3);
    expect(rec.outer.associations).toEqual([
      { cameraKey: "CAM_L", tripleHash: undefined, role: undefined },
    ]);
    // mtime → created ISO.
    expect(rec.outer.created).toBe("2026-06-01T00:00:00.000Z");

    // Version marker advanced.
    expect(await readSchemaVersion(fs)).toBe(1);
  });

  it("is idempotent — a second run is a no-op", async () => {
    const fs = fakeFs({
      "calibrate-extrinsic/CAM_L": legacyDataset(3),
    });
    await runMigrations(fs, { ctx });
    const snapshot = JSON.stringify([...fs.disk.entries()].sort());

    const res2 = await runMigrations(fs, { ctx });
    expect(res2.applied).toEqual([]); // already at target
    expect(res2.from).toBe(1);
    expect(JSON.stringify([...fs.disk.entries()].sort())).toBe(snapshot);
  });

  it("re-running the 0→1 STEP directly converges (union, no dup)", async () => {
    // Simulate a crash between record-write and version-write: version still 0
    // but the record already exists and the legacy doc is gone.
    const fs = fakeFs({ "calibrate-extrinsic/CAM_L": legacyDataset(3) });
    await MIGRATIONS[0]!.run(fs, ctx); // first pass (no version write)
    const before = JSON.stringify([...fs.disk.entries()].sort());
    // Restore the legacy doc to force the union path.
    fs.disk.set("calibrate-extrinsic/CAM_L", legacyDataset(3));
    await MIGRATIONS[0]!.run(fs, ctx);
    // The record still has exactly one association (idempotent union).
    const id = await recordId(extrinsicInner(legacyDataset(3)));
    const rec = fs.disk.get(`${RECORD_STORE}/${id}`) as CalibrationRecord;
    expect(rec.outer.associations).toHaveLength(1);
    expect(fs.disk.has("calibrate-extrinsic/CAM_L")).toBe(false); // moved again
    void before;
  });
});

describe("snapshot hook", () => {
  it("fires before + after ONLY when work is pending", async () => {
    const fs = fakeFs({ "calibrate-extrinsic/CAM_L": legacyDataset(1) });
    const snapshot = vi.fn(async () => {});
    await runMigrations(fs, { ctx, snapshot });
    expect(snapshot.mock.calls.map((c) => c[0])).toEqual(["before", "after"]);

    // Already current → no snapshot.
    const snapshot2 = vi.fn(async () => {});
    await runMigrations(fs, { ctx, snapshot: snapshot2 });
    expect(snapshot2).not.toHaveBeenCalled();
  });
});
