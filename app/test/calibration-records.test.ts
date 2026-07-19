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
  intrinsicInner,
  isRecordId,
  makeRecord,
  migrateLegacyExtrinsic,
  migrateLegacyIntrinsic,
  orderRecordsLatestFirst,
  reKeyTripleHash,
  recordBelongsToTriple,
  recordId,
  removeAssociations,
  resolveActiveDataset,
  resolveActiveIntrinsic,
  resolveNickname,
  toRecordExport,
  tripleAssociationMatcher,
  truncateHashHex,
  RECORD_ID_HEX,
  EXTRINSIC_STORE,
  INTRINSIC_STORE,
  recordStore,
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
    expect(id1).toMatch(/^[0-9a-f]{32}$/); // 32-hex truncated SHA-256
    expect(id1).toHaveLength(RECORD_ID_HEX);
    expect(isRecordId(id1)).toBe(true);
  });

  it("the 32-hex id is the truncation of the full SHA-256 (stable width)", async () => {
    const inner = extrinsicInner(dataset(3));
    const full = await import("@lib/util/hash").then((m) => m.sha256(canonicalize(inner)));
    expect(await recordId(inner)).toBe(truncateHashHex(full));
    expect(full).toHaveLength(64);
    expect(truncateHashHex(full)).toHaveLength(32);
  });

  it("isRecordId distinguishes 32-hex ids from camera keys / .raw artifacts", () => {
    expect(isRecordId("a".repeat(32))).toBe(true);
    expect(isRecordId("FLIR_Blackfly-S-BFS-U3-16S2C_24044020")).toBe(false); // camera key
    expect(isRecordId("a".repeat(64))).toBe(false); // full hash (legacy width)
    expect(isRecordId(`${"a".repeat(32)}.raw`)).toBe(false); // artifact
    expect(isRecordId("A".repeat(32))).toBe(false); // upper-case not an id
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

describe("typed-array canonicalization (intrinsic Mats)", () => {
  /** A Float64Array carrying `shape`/`channels` expando props, like a Mat. */
  function mat(values: number[], shape: number[], channels = 1) {
    const a = new Float64Array(values) as Float64Array & {
      shape: number[];
      channels: number;
    };
    a.shape = shape;
    a.channels = channels;
    return a;
  }

  it("is deterministic + stable across independent Mats with equal content", () => {
    const a = mat([1, 2, 3, 4], [2, 2]);
    const b = mat([1, 2, 3, 4], [2, 2]);
    expect(canonicalize({ m: a })).toBe(canonicalize({ m: b }));
  });

  it("differs on content, shape, or props", () => {
    const base = mat([1, 2, 3, 4], [2, 2]);
    expect(canonicalize({ m: base })).not.toBe(canonicalize({ m: mat([1, 2, 3, 5], [2, 2]) }));
    expect(canonicalize({ m: base })).not.toBe(canonicalize({ m: mat([1, 2, 3, 4], [4, 1]) }));
    expect(canonicalize({ m: base })).not.toBe(canonicalize({ m: mat([1, 2, 3, 4], [2, 2], 3) }));
  });

  it("a live Mat and its store-codec {type,buffer,props} encoding canonicalize identically", async () => {
    // The contract that lets the codec-reviving app and the plain-JSON migration
    // runner agree on an intrinsic record's id.
    const { replacer } = await import("@lib/store-codec");
    const live = mat([1.5, -2.25, 3, 4], [2, 2]);
    const encoded = JSON.parse(JSON.stringify({ m: live }, replacer)); // {m:{type,buffer,props}}
    expect(canonicalize({ m: live })).toBe(canonicalize(encoded));
  });

  it("a SUBARRAY view canonicalizes by its own bytes and still mirrors the codec (latent)", async () => {
    // byteOffset/byteLength honored: a view over part of a larger buffer must
    // hash only its own bytes — identical to a compact copy of the same values —
    // and must keep byte-matching the codec's on-disk encoding.
    const { replacer } = await import("@lib/store-codec");
    const backing = new Float64Array([9, 9, 1.5, -2.25, 3, 4, 9]);
    const view = Object.assign(backing.subarray(2, 6), { shape: [2, 2], channels: 1 });
    const compact = mat([1.5, -2.25, 3, 4], [2, 2]);
    expect(canonicalize({ m: view })).toBe(canonicalize({ m: compact }));
    const encoded = JSON.parse(JSON.stringify({ m: view }, replacer));
    expect(canonicalize({ m: view })).toBe(canonicalize(encoded));
  });

  it("an intrinsic record's id is stable across the codec encode round-trip", async () => {
    const { replacer, reviver } = await import("@lib/store-codec");
    const calibration = {
      camera_matrix: mat([1000, 0, 640, 0, 1000, 480, 0, 0, 1], [3, 3]),
      dist_coeffs: mat([0.1, -0.2, 0, 0, 0], [1, 5]),
      sensor_size: { width: 1280, height: 960 },
      rvecs: [mat([0.1, 0.2, 0.3], [3, 1])],
      tvecs: [mat([1, 2, 3], [3, 1])],
      date: new Date("2026-02-19T05:28:05.310Z"),
    };
    const inner = intrinsicInner(calibration);
    expect(inner.kind).toBe("intrinsic");
    expect(inner.calibration).not.toHaveProperty("date"); // volatile → outer.created
    const idLive = await recordId(inner);
    // Round-trip the inner through the store codec (what the app writes/reads).
    const revived = JSON.parse(JSON.stringify(inner, replacer), reviver);
    expect(await recordId(revived)).toBe(idLive);
    expect(idLive).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("intrinsic records", () => {
  const calib = () => ({
    camera_matrix: [1, 0, 2, 0, 1, 3, 0, 0, 1],
    dist_coeffs: [0, 0, 0, 0, 0],
    rvecs: [[0], [0], [0]], // 3 "views"
    tvecs: [[0], [0], [0]],
    sensor_size: { width: 100, height: 80 },
    date: new Date("2026-02-01T00:00:00.000Z"),
  });

  it("wraps a legacy CameraCalibration doc, stripping date → created", async () => {
    const rec = await migrateLegacyIntrinsic("CENTER_CAM", calib(), {
      created: "2026-02-01T00:00:00.000Z",
    });
    expect(rec.inner.kind).toBe("intrinsic");
    expect((rec.inner as { calibration: Record<string, unknown> }).calibration).not.toHaveProperty("date");
    expect(rec.outer.associations).toEqual([{ cameraKey: "CENTER_CAM", role: undefined }]);
    expect(rec.outer.created).toBe("2026-02-01T00:00:00.000Z");
    expect(rec.id).toBe(await recordId(intrinsicInner(calib())));
  });

  it("resolveActiveIntrinsic returns the latest bound intrinsic calibration (else null)", async () => {
    const older = await makeRecord(intrinsicInner({ ...calib(), rvecs: [[0]] }), {
      created: "2026-02-01T00:00:00.000Z",
      associations: [{ cameraKey: "C" }],
    });
    const newer = await makeRecord(intrinsicInner(calib()), {
      created: "2026-03-01T00:00:00.000Z",
      associations: [{ cameraKey: "C" }],
    });
    const active = resolveActiveIntrinsic([older, newer], "C");
    expect(active?.created).toBe("2026-03-01T00:00:00.000Z");
    expect(active?.calibration).toEqual((newer.inner as { calibration: unknown }).calibration);
    expect(resolveActiveIntrinsic([older, newer], "OTHER")).toBeNull();
    // An extrinsic record bound to the same key is ignored by the intrinsic resolver.
    const ext = await makeRecord(extrinsicInner(dataset(2)), {
      created: "2026-09-01T00:00:00.000Z",
      associations: [{ cameraKey: "C" }],
    });
    expect(resolveActiveIntrinsic([ext], "C")).toBeNull();
    expect(resolveActiveDataset([newer], "C")).toBeNull(); // intrinsic ignored by extrinsic resolver
  });

  it("aggregation refuses intrinsic records (never cross-kind)", async () => {
    const intr = await makeRecord(intrinsicInner(calib()), {
      created: "2026-02-01T00:00:00.000Z",
      associations: [{ cameraKey: "C" }],
    });
    const extr = await makeRecord(extrinsicInner(dataset(2)), {
      created: "2026-02-02T00:00:00.000Z",
      associations: [{ cameraKey: "L" }],
    });
    await expect(aggregateRecords([intr, intr], { created: "x" })).rejects.toThrow(/extrinsic/);
    await expect(aggregateRecords([extr, intr], { created: "x" })).rejects.toThrow(/extrinsic/);
  });

  it("recordStore maps each kind to its per-kind directory", () => {
    expect(recordStore("extrinsic")).toBe(EXTRINSIC_STORE);
    expect(recordStore("intrinsic")).toBe(INTRINSIC_STORE);
    expect(EXTRINSIC_STORE).toBe("calibrate-extrinsic");
    expect(INTRINSIC_STORE).toBe("calibrate-intrinsic");
  });
});

describe("triple-hash re-key (v1→v2)", () => {
  it("truncates a full 64-hex hash to 32, leaves 32-hex / non-hash untouched", () => {
    const full = "a".repeat(32) + "b".repeat(32);
    expect(reKeyTripleHash(full)).toBe("a".repeat(32));
    expect(reKeyTripleHash("a".repeat(32))).toBe("a".repeat(32)); // already 32
    expect(reKeyTripleHash(undefined)).toBeUndefined();
    expect(reKeyTripleHash("not-a-hash")).toBe("not-a-hash");
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

  it("an EMPTY latest record never shadows an older good one", async () => {
    const a: Association = { cameraKey: "camA" };
    const good = await makeRecord(extrinsicInner(dataset(4)), {
      created: "2026-07-01T00:00:00.000Z",
      associations: [a],
    });
    const emptyNewest = await makeRecord(extrinsicInner([]), {
      created: "2026-07-10T00:00:00.000Z",
      associations: [a],
    });
    // The empty newest is skipped; the resolver falls through to the
    // next-newest NON-EMPTY record.
    expect(resolveActiveDataset([good, emptyNewest], "camA")).toBe(good.inner.dataset);
  });

  it("all-empty bound records resolve to null (legacy fallback still reachable)", async () => {
    const a: Association = { cameraKey: "camA" };
    const empty = await makeRecord(extrinsicInner([]), {
      created: "2026-07-10T00:00:00.000Z",
      associations: [a],
    });
    expect(resolveActiveDataset([empty], "camA")).toBeNull();
  });
});
