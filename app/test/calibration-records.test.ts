// Coverage for the calibration-records data model (`@lib/calibration-records`):
// content-hash identity (stability across key order / nesting / typed values),
// legacy migration, association add/remove/refcount-to-zero, aggregation
// (concat + new id + provenance), device-config export/import (records attached,
// associations stripped; existing id → associate; inner mismatch detected),
// nickname resolution, active-dataset resolution, and latest-first ordering.

import { describe, expect, it } from "vitest";
import type { ExtrinsicData, ExtrinsicDataset } from "@lib/camera-config";
import {
  addAssociation,
  aggregateRecords,
  buildDeviceExport,
  canonicalize,
  decideImport,
  extrinsicInner,
  hasAssociation,
  innerMatches,
  makeRecord,
  migrateLegacyExtrinsic,
  orderRecordsLatestFirst,
  recordBelongsToTriple,
  recordId,
  removeAssociations,
  resolveActiveDataset,
  resolveNickname,
  toRecordExport,
  tripleAssociationMatcher,
  type Association,
  type CalibrationRecord,
} from "@lib/calibration-records";

/** A minimal but shape-valid extrinsic datapoint. */
function dp(seed: number): ExtrinsicData {
  return {
    img_points: [
      { x: seed, y: seed },
      { x: seed + 1, y: seed },
      { x: seed + 1, y: seed + 1 },
      { x: seed, y: seed + 1 },
    ],
    obj_points: [
      { x: -0.5, y: -0.5, z: 0 },
      { x: 0.5, y: -0.5, z: 0 },
      { x: 0.5, y: 0.5, z: 0 },
      { x: -0.5, y: 0.5, z: 0 },
    ],
    voltage: { x: seed / 10, y: seed / 20 },
    angle: { x: seed / 100, y: seed / 200 },
  };
}

const dataset = (n: number): ExtrinsicDataset =>
  Array.from({ length: n }, (_, i) => dp(i + 1));

describe("content-hash identity", () => {
  it("is stable regardless of object key order (canonicalization)", () => {
    const a = { kind: "extrinsic", dataset: [{ x: 1, y: 2, z: 3 }] };
    const b = { dataset: [{ z: 3, x: 1, y: 2 }], kind: "extrinsic" };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("preserves ARRAY order (datapoint order is significant)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("treats an absent optional field the same as an explicit undefined", () => {
    expect(canonicalize({ a: 1 })).toBe(canonicalize({ a: 1, b: undefined }));
  });

  it("same dataset → same id across independent calls", async () => {
    const id1 = await recordId(extrinsicInner(dataset(3)));
    const id2 = await recordId(extrinsicInner(dataset(3)));
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("different data → different id", async () => {
    const id1 = await recordId(extrinsicInner(dataset(3)));
    const id2 = await recordId(extrinsicInner(dataset(4)));
    expect(id1).not.toBe(id2);
  });

  it("distinguishes numeric vs string typed values", () => {
    expect(canonicalize({ v: 1 })).not.toBe(canonicalize({ v: "1" }));
  });
});

describe("legacy migration", () => {
  it("wraps a flat dataset losslessly, id stable, one synthesized association", async () => {
    const ds = dataset(5);
    const rec = await migrateLegacyExtrinsic("VENDOR_MODEL_L001", ds, {
      created: "2026-07-01T00:00:00.000Z",
      role: "L",
    });
    expect(rec.inner.dataset).toBe(ds); // verbatim, no copy/loss
    expect(rec.id).toBe(await recordId(extrinsicInner(ds)));
    expect(rec.outer.associations).toEqual([
      { cameraKey: "VENDOR_MODEL_L001", tripleHash: undefined, role: "L" },
    ]);
    expect(rec.outer.created).toBe("2026-07-01T00:00:00.000Z");

    // Re-wrapping the same data yields the same id (idempotent by construction).
    const again = await migrateLegacyExtrinsic("VENDOR_MODEL_L001", dataset(5), {
      created: "2026-07-09T00:00:00.000Z",
    });
    expect(again.id).toBe(rec.id);
  });
});

describe("associations + refcounted delete", () => {
  const base = async (): Promise<CalibrationRecord> =>
    makeRecord(extrinsicInner(dataset(2)), {
      created: "2026-07-01T00:00:00.000Z",
      associations: [{ cameraKey: "camA", tripleHash: "triA" }],
    });

  it("adds a binding (idempotent on a duplicate)", async () => {
    let rec = await base();
    rec = addAssociation(rec, { cameraKey: "camB", tripleHash: "triB" });
    expect(rec.outer.associations).toHaveLength(2);
    // Duplicate (cameraKey, tripleHash) is a no-op.
    const same = addAssociation(rec, { cameraKey: "camB", tripleHash: "triB" });
    expect(same).toBe(rec);
    expect(hasAssociation(rec, { cameraKey: "camB", tripleHash: "triB" })).toBe(true);
  });

  it("removing the last association reports orphaned (→ trash the file)", async () => {
    const rec = await base();
    const { record, orphaned } = removeAssociations(
      rec,
      (a) => a.tripleHash === "triA",
    );
    expect(record.outer.associations).toHaveLength(0);
    expect(orphaned).toBe(true);
  });

  it("removing one of several bindings keeps the record (not orphaned)", async () => {
    let rec = await base();
    rec = addAssociation(rec, { cameraKey: "camB", tripleHash: "triB" });
    const { record, orphaned } = removeAssociations(rec, (a) => a.tripleHash === "triA");
    expect(orphaned).toBe(false);
    expect(record.outer.associations).toEqual([{ cameraKey: "camB", tripleHash: "triB" }]);
  });

  it("belongs-to-triple matches by explicit hash OR legacy cameraKey", async () => {
    const explicit = await makeRecord(extrinsicInner(dataset(1)), {
      created: "2026-07-01T00:00:00.000Z",
      associations: [{ cameraKey: "camA", tripleHash: "triA" }],
    });
    const legacy = await makeRecord(extrinsicInner(dataset(2)), {
      created: "2026-07-01T00:00:00.000Z",
      associations: [{ cameraKey: "camL" }], // no tripleHash (migrated)
    });
    expect(recordBelongsToTriple(explicit, "triA", [])).toBe(true);
    expect(recordBelongsToTriple(explicit, "triZ", ["camA"])).toBe(false); // hash wins when present
    // Legacy binding surfaces under a triple whose live L/R key matches.
    expect(recordBelongsToTriple(legacy, "triA", ["camL", "camR"])).toBe(true);
    expect(recordBelongsToTriple(legacy, "triA", ["camX"])).toBe(false);

    // The matcher removes exactly the bindings that made it belong.
    const { orphaned } = removeAssociations(
      legacy,
      tripleAssociationMatcher("triA", ["camL", "camR"]),
    );
    expect(orphaned).toBe(true);
  });
});

describe("aggregation", () => {
  it("concatenates datasets into a NEW record with provenance + fresh id", async () => {
    const a = await makeRecord(extrinsicInner(dataset(2)), {
      created: "2026-07-01T00:00:00.000Z",
      associations: [{ cameraKey: "camA", tripleHash: "triA" }],
    });
    const b = await makeRecord(extrinsicInner(dataset(3)), {
      created: "2026-07-02T00:00:00.000Z",
      associations: [{ cameraKey: "camA", tripleHash: "triA" }],
    });
    const agg = await aggregateRecords([a, b], {
      created: "2026-07-03T00:00:00.000Z",
      association: { cameraKey: "camA", tripleHash: "triA" },
    });
    expect(agg.inner.dataset).toHaveLength(5); // 2 + 3 concatenated
    expect(agg.id).not.toBe(a.id);
    expect(agg.id).not.toBe(b.id);
    expect(agg.id).toBe(await recordId(extrinsicInner([...a.inner.dataset, ...b.inner.dataset])));
    expect(agg.outer.sources).toEqual([a.id, b.id]);
    // Sources untouched.
    expect(a.inner.dataset).toHaveLength(2);
    expect(b.inner.dataset).toHaveLength(3);
  });
});

describe("device-config export / import", () => {
  it("attaches associated records with associations stripped", async () => {
    const rec = await makeRecord(extrinsicInner(dataset(4)), {
      created: "2026-07-01T00:00:00.000Z",
      label: "bench",
      associations: [{ cameraKey: "camA", tripleHash: "triA", role: "L" }],
    });
    const bundle = buildDeviceExport(
      { nickname: "Rig One", baseline_mm: 180 },
      [rec],
      { now: "2026-07-05T00:00:00.000Z", sourceTripleHash: "triA" },
    );
    expect(bundle.schema).toBe("fovea-device-config@1");
    expect(bundle.config).toEqual({ nickname: "Rig One", baseline_mm: 180 });
    expect(bundle.records).toHaveLength(1);
    const exp = bundle.records[0]!;
    expect(exp).not.toHaveProperty("associations");
    expect(exp.role).toBe("L"); // advisory, for re-binding on import
    expect(exp.inner).toEqual(rec.inner);
  });

  it("import of an existing id → associate; inner mismatch is detected", async () => {
    const rec = await makeRecord(extrinsicInner(dataset(4)), {
      created: "2026-07-01T00:00:00.000Z",
      associations: [{ cameraKey: "camA", tripleHash: "triA" }],
    });
    const incoming = toRecordExport(rec);

    // Existing record with identical inner → associate, no data mismatch.
    const d1 = await decideImport(incoming, rec);
    expect(d1.action).toBe("associate");
    expect(d1.id).toBe(rec.id);
    expect(d1.idMismatch).toBe(false);
    expect(d1.dataMismatch).toBe(false);

    // No existing record → create.
    const d2 = await decideImport(incoming, null);
    expect(d2.action).toBe("create");

    // Existing record with the SAME id but different inner (corrupt bundle) →
    // associate BUT flag the mismatch.
    const tampered = { ...rec, inner: extrinsicInner(dataset(9)) };
    const d3 = await decideImport({ ...incoming, id: rec.id }, tampered);
    expect(d3.action).toBe("associate");
    expect(d3.dataMismatch).toBe(true);
  });

  it("innerMatches compares inner byte-for-byte (canonical)", () => {
    expect(innerMatches(extrinsicInner(dataset(2)), extrinsicInner(dataset(2)))).toBe(true);
    expect(innerMatches(extrinsicInner(dataset(2)), extrinsicInner(dataset(3)))).toBe(false);
  });
});

describe("nickname resolution (Welcome)", () => {
  it("returns the trimmed nickname of the connected triple, else null", () => {
    const docs = { triA: { nickname: "  Lab Rig  " }, triB: { nickname: "" } };
    expect(resolveNickname("triA", docs)).toBe("Lab Rig");
    expect(resolveNickname("triB", docs)).toBeNull(); // empty → null
    expect(resolveNickname("triC", docs)).toBeNull(); // unknown → null
    expect(resolveNickname(null, docs)).toBeNull(); // no rig → null
  });
});

describe("active-dataset resolution + ordering", () => {
  it("latest-first ordering by created timestamp", async () => {
    const older = await makeRecord(extrinsicInner(dataset(1)), {
      created: "2026-07-01T00:00:00.000Z",
      associations: [],
    });
    const newer = await makeRecord(extrinsicInner(dataset(2)), {
      created: "2026-07-08T00:00:00.000Z",
      associations: [],
    });
    expect(orderRecordsLatestFirst([older, newer]).map((r) => r.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("resolves the LATEST record bound to a camera (else null)", async () => {
    const a: Association = { cameraKey: "camA" };
    const older = await makeRecord(extrinsicInner(dataset(1)), {
      created: "2026-07-01T00:00:00.000Z",
      associations: [a],
    });
    const newer = await makeRecord(extrinsicInner(dataset(2)), {
      created: "2026-07-08T00:00:00.000Z",
      associations: [a],
    });
    const other = await makeRecord(extrinsicInner(dataset(3)), {
      created: "2026-07-09T00:00:00.000Z",
      associations: [{ cameraKey: "camB" }],
    });
    expect(resolveActiveDataset([older, newer, other], "camA")).toBe(newer.inner.dataset);
    expect(resolveActiveDataset([other], "camA")).toBeNull();
  });
});
