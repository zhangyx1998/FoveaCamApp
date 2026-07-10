// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Calibration-records data model (docs/proposals/calibration-records-v2.md).
//
// A calibration RECORD is the store-v1 replacement for the flat per-camera
// extrinsic dataset. It splits into:
//
//   • IMMUTABLE inner data (`ExtrinsicInner`) — the raw datapoint array plus
//     whatever the solve consumes. This is the HASH PRE-IMAGE: the record `id`
//     (its primary key AND store filename) is the SHA-256 of a canonical,
//     key-sorted serialization of `inner`. Pure + deterministic → the same
//     datapoints always yield the same id, across sessions/platforms, so a
//     record imported from another rig collides with an identical local one
//     (import then just ADDS an association).
//
//   • MUTABLE outer metadata (`RecordMeta`) — associations (camera-instance ⇄
//     triple bindings), a creation timestamp (latest-first ordering key), an
//     optional label, and (for aggregates) the source record ids. Editing the
//     outer metadata NEVER changes the id (only the inner data does).
//
// This module is PURE (no store IO, no Vue, no core/): the config window, the
// orchestrator load path, and the store-migration framework all inject their
// own IO around these functions, and every function here is unit-testable with
// plain objects. `sha256` is the only async dependency (WebCrypto, available in
// both the renderer and the node/main contexts).

import { sha256 } from "./util/hash.js";
import type { ExtrinsicDataset } from "./camera-config.js";

/** Store directory the record documents live under (`["calibration-records",
 *  <id>]`). One JSON file per record, named by its content-hash id. */
export const RECORD_STORE = "calibration-records";

/** Inner-data schema tag — part of the hash pre-image, so bumping it re-keys
 *  every record (a deliberate, migration-gated event). v1 = the extrinsic
 *  datapoint array as captured by calibrate-extrinsic. */
export const RECORD_INNER_KIND = "extrinsic" as const;

/**
 * The IMMUTABLE inner data of an extrinsic record — the hash pre-image. Keep
 * this to raw, solve-relevant data only: anything volatile or fit-derived
 * (RMS, regressions, timestamps) would make the id unstable and must live in
 * the outer metadata instead.
 */
export interface ExtrinsicInner {
  /** Discriminant + schema tag (hashed). */
  kind: typeof RECORD_INNER_KIND;
  /** The raw per-fovea datapoint array, verbatim from calibrate-extrinsic
   *  (`createDataSet`). The array ORDER is significant and preserved through
   *  the hash (arrays are not reordered by canonicalization). */
  dataset: ExtrinsicDataset;
}

/**
 * One binding of a record to a camera instance within a triple. A record may
 * carry MANY (multi-association across rigs). `tripleHash` is optional: legacy
 * migrations bind by `cameraKey` alone (no live triple hash was available),
 * and the UI then matches such a record to a triple whose live L/R camera key
 * equals `cameraKey` — see {@link recordBelongsToTriple}.
 */
export interface Association {
  /** Camera identity key (`vendor_model_serial`, `getCameraKey`) this binding
   *  targets — the EYE the record calibrates in the bound triple. */
  cameraKey: string;
  /** The triple hash this binding was created under (`["triples", <hash>]`).
   *  Absent on legacy-migrated bindings (matched by `cameraKey` instead). */
  tripleHash?: string;
  /** Advisory role within the triple at binding time (`"L"` / `"R"`). */
  role?: string;
}

/** The MUTABLE outer metadata — editable without changing the record id. */
export interface RecordMeta {
  /** ISO-8601 creation/calibration timestamp. Lexical sort == chronological,
   *  so this is the latest-first ordering key. */
  created: string;
  /** Optional human label (nickname for the record, distinct from the triple
   *  nickname). */
  label?: string;
  /** Camera-instance ⇄ triple bindings. The refcount for the trash rule: when
   *  this drops to 0, the record file moves to the OS trash. */
  associations: Association[];
  /** For AGGREGATED records: the source record ids whose datasets were
   *  concatenated (provenance). Absent on primary records. Sources are left
   *  untouched by aggregation. */
  sources?: string[];
}

/** A full record document (`["calibration-records", <id>]`). */
export interface CalibrationRecord {
  /** Content-hash id (also the store filename). Equals `recordId(inner)`. */
  id: string;
  inner: ExtrinsicInner;
  outer: RecordMeta;
}

// ---- Content-hash identity -------------------------------------------------

/**
 * Canonical, deterministic serialization for hashing: object keys are sorted
 * recursively (so key insertion order never affects the id) while ARRAY order
 * is preserved (datapoint order is meaningful). `undefined` values and missing
 * optional fields are omitted identically (JSON semantics), so a datapoint that
 * lacks `wide_img_points` hashes the same whether the field is absent or
 * explicitly `undefined`. Pure; unit-tested for key-order / nesting / typed
 * values stability.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue; // match JSON's undefined-omission
      out[k] = sortDeep(src[k]);
    }
    return out;
  }
  return v;
}

/** The content-hash id (primary key) for a piece of inner data. Same inner →
 *  same id, forever. */
export function recordId(inner: ExtrinsicInner): Promise<string> {
  return sha256(canonicalize(inner));
}

/** Build the immutable inner data for an extrinsic datapoint array. */
export function extrinsicInner(dataset: ExtrinsicDataset): ExtrinsicInner {
  return { kind: RECORD_INNER_KIND, dataset };
}

/** Assemble a fresh record from inner data + outer metadata (id derived). */
export async function makeRecord(
  inner: ExtrinsicInner,
  outer: RecordMeta,
): Promise<CalibrationRecord> {
  return { id: await recordId(inner), inner, outer };
}

// ---- Legacy migration ------------------------------------------------------

/**
 * Wrap a LEGACY flat extrinsic dataset (store v0: `["calibrate-extrinsic",
 * <cameraKey>]` = a bare `ExtrinsicData[]`) as a record with ZERO data loss:
 * the array becomes the inner data verbatim, the id is its content hash, and
 * the outer metadata synthesizes one association to the owning camera. The
 * `created` timestamp comes from the caller (existing metadata or the file
 * mtime — the migration passes the store file's mtime). `tripleHash`/`role`
 * are best-effort provenance; a legacy dataset alone carries neither, so the
 * migration usually binds by `cameraKey` only.
 *
 * Pure + idempotent by construction: the id is a function of the dataset only,
 * so re-wrapping the same dataset produces the same id (the migration framework
 * relies on this for its run-twice-is-a-no-op guarantee).
 */
export async function migrateLegacyExtrinsic(
  cameraKey: string,
  dataset: ExtrinsicDataset,
  meta: { created: string; tripleHash?: string; role?: string; label?: string },
): Promise<CalibrationRecord> {
  const inner = extrinsicInner(dataset);
  return {
    id: await recordId(inner),
    inner,
    outer: {
      created: meta.created,
      label: meta.label,
      associations: [
        { cameraKey, tripleHash: meta.tripleHash, role: meta.role },
      ],
    },
  };
}

// ---- Associations + refcounted delete --------------------------------------

/** Whether two bindings target the same (cameraKey, tripleHash) pair. A missing
 *  `tripleHash` is its own distinct slot (the unassigned/legacy binding). */
function sameBinding(a: Association, b: Association): boolean {
  return a.cameraKey === b.cameraKey && (a.tripleHash ?? "") === (b.tripleHash ?? "");
}

/** True when the record already carries the given binding. */
export function hasAssociation(rec: CalibrationRecord, assoc: Association): boolean {
  return rec.outer.associations.some((a) => sameBinding(a, assoc));
}

/**
 * Add a binding (idempotent — a duplicate (cameraKey, tripleHash) is a no-op).
 * Returns a NEW record (outer replaced); the id is unchanged (inner untouched).
 */
export function addAssociation(
  rec: CalibrationRecord,
  assoc: Association,
): CalibrationRecord {
  if (hasAssociation(rec, assoc)) return rec;
  return {
    ...rec,
    outer: { ...rec.outer, associations: [...rec.outer.associations, assoc] },
  };
}

/**
 * Remove every binding that matches a predicate and report whether the record
 * is now ORPHANED (0 associations → the caller trashes the file). `match`
 * receives each association; the config window passes the "belongs to THIS
 * triple" test so a discard drops exactly the current triple's binding(s).
 */
export function removeAssociations(
  rec: CalibrationRecord,
  match: (a: Association) => boolean,
): { record: CalibrationRecord; orphaned: boolean } {
  const associations = rec.outer.associations.filter((a) => !match(a));
  return {
    record: { ...rec, outer: { ...rec.outer, associations } },
    orphaned: associations.length === 0,
  };
}

/**
 * The "does this record belong to triple T" test used by the Device tab's
 * record list AND by discard. A record belongs when it has a binding that
 * either (a) names `tripleHash` explicitly, or (b) is an unassigned/legacy
 * binding whose `cameraKey` is one of the triple's live L/R camera keys
 * (`liveKeys`). Legacy-migrated records — bound by cameraKey only — thus surface
 * under the connected rig with no triple-hash bookkeeping in the migration.
 */
export function recordBelongsToTriple(
  rec: CalibrationRecord,
  tripleHash: string,
  liveKeys: readonly string[],
): boolean {
  return rec.outer.associations.some((a) =>
    a.tripleHash != null
      ? a.tripleHash === tripleHash
      : liveKeys.includes(a.cameraKey),
  );
}

/** The association predicate matching {@link recordBelongsToTriple} — the exact
 *  bindings a discard-from-triple removes. */
export function tripleAssociationMatcher(
  tripleHash: string,
  liveKeys: readonly string[],
): (a: Association) => boolean {
  return (a) =>
    a.tripleHash != null ? a.tripleHash === tripleHash : liveKeys.includes(a.cameraKey);
}

// ---- Aggregation -----------------------------------------------------------

/**
 * Aggregate N records into a NEW record whose inner dataset is the CONCATENATION
 * of the sources' datapoint arrays (in the given order). The new record gets a
 * fresh content-hash id, records the source ids in `outer.sources`, and takes
 * the caller-supplied association (typically the current triple) so it surfaces
 * immediately. The SOURCES ARE NOT MUTATED — aggregation is additive.
 */
export async function aggregateRecords(
  records: readonly CalibrationRecord[],
  meta: { created: string; label?: string; association?: Association },
): Promise<CalibrationRecord> {
  const dataset: ExtrinsicDataset = records.flatMap((r) => r.inner.dataset);
  const inner = extrinsicInner(dataset);
  return {
    id: await recordId(inner),
    inner,
    outer: {
      created: meta.created,
      label: meta.label,
      associations: meta.association ? [meta.association] : [],
      sources: records.map((r) => r.id),
    },
  };
}

/** Total datapoint count across a record's inner dataset (list-row summary). */
export function datapointCount(rec: CalibrationRecord): number {
  return rec.inner.dataset.length;
}

/** Latest-first ordering (newest `created` on top). Stable; pure. */
export function orderRecordsLatestFirst(
  records: readonly CalibrationRecord[],
): CalibrationRecord[] {
  return [...records].sort((a, b) => b.outer.created.localeCompare(a.outer.created));
}

/**
 * Resolve the ACTIVE dataset a camera should calibrate with: the LATEST record
 * (by `created`) associated with `cameraKey`. Null when no record is bound —
 * the orchestrator loader then falls back to the legacy flat doc (pre-migration
 * safety). Pure; unit-tested.
 */
export function resolveActiveDataset(
  records: readonly CalibrationRecord[],
  cameraKey: string,
): ExtrinsicDataset | null {
  const bound = records.filter((r) =>
    r.outer.associations.some((a) => a.cameraKey === cameraKey),
  );
  if (bound.length === 0) return null;
  return orderRecordsLatestFirst(bound)[0]!.inner.dataset;
}

// ---- Import / export bundles ----------------------------------------------

/** Wire schema tag for a single-record export file (EXTERNAL mode). */
export const RECORD_EXPORT_SCHEMA = "fovea-calibration-record@1";
/** Wire schema tag for a device-config bundle export file. */
export const DEVICE_EXPORT_SCHEMA = "fovea-device-config@1";

/**
 * A record as written to an EXTERNAL JSON file: the immutable inner data plus
 * the id and provenance, but WITHOUT associations (those are rig-local and are
 * re-created on import against the importing triple). `role` is advisory, so an
 * importer can re-bind the record to the correct eye.
 */
export interface RecordExport {
  id: string;
  inner: ExtrinsicInner;
  created: string;
  label?: string;
  sources?: string[];
  role?: string;
}

/** A single-record export file (EXTERNAL export of one record). */
export interface RecordExportFile {
  schema: typeof RECORD_EXPORT_SCHEMA;
  exported: string;
  record: RecordExport;
}

/** A device-config export bundle: the per-triple config doc (nickname +
 *  overrides) WITH its associated records attached, associations stripped. */
export interface DeviceExportFile {
  schema: typeof DEVICE_EXPORT_SCHEMA;
  exported: string;
  /** Provenance: the source triple hash (so a re-import onto the SAME rig skips
   *  the cross-triple nickname prompt). Never used as an association. */
  sourceTripleHash?: string;
  /** The per-triple config doc verbatim (nickname, baseline_mm, zoom_override,
   *  settle_time_us, delay_compensation_ms, drift_l/r, …). */
  config: Record<string, unknown>;
  /** The triple's associated records, associations STRIPPED. */
  records: RecordExport[];
}

/** Strip a record down to its export shape (associations removed). `role` is
 *  taken from the first association's role when available. */
export function toRecordExport(rec: CalibrationRecord): RecordExport {
  return {
    id: rec.id,
    inner: rec.inner,
    created: rec.outer.created,
    label: rec.outer.label,
    sources: rec.outer.sources,
    role: rec.outer.associations[0]?.role,
  };
}

/** Build a single-record EXTERNAL export file. */
export function buildRecordExport(
  rec: CalibrationRecord,
  now: string,
): RecordExportFile {
  return { schema: RECORD_EXPORT_SCHEMA, exported: now, record: toRecordExport(rec) };
}

/**
 * Build a device-config EXPORT bundle: the config doc plus every associated
 * record with associations stripped (requirement 2). The caller supplies the
 * records already filtered to this triple.
 */
export function buildDeviceExport(
  config: Record<string, unknown>,
  records: readonly CalibrationRecord[],
  meta: { now: string; sourceTripleHash?: string },
): DeviceExportFile {
  return {
    schema: DEVICE_EXPORT_SCHEMA,
    exported: meta.now,
    sourceTripleHash: meta.sourceTripleHash,
    config,
    records: records.map(toRecordExport),
  };
}

/** Verify an incoming record's inner data is byte-equal to an existing record's
 *  (canonical compare). Used on import when the id already exists, to WARN on a
 *  hash collision that isn't actually the same data (should never happen with
 *  SHA-256, but a corrupt/hand-edited bundle could carry a mismatched id). */
export function innerMatches(a: ExtrinsicInner, b: ExtrinsicInner): boolean {
  return canonicalize(a) === canonicalize(b);
}

/**
 * Decide what importing one record (from an EXTERNAL file, or an INTERNAL
 * association to a target triple) should do against the current store. Pure —
 * the caller performs the resulting store write. When a record with the
 * recomputed id already exists, the decision is `associate` (just add the
 * binding); otherwise `create`. `idMismatch`/`dataMismatch` flag a corrupt
 * bundle (recomputed id ≠ declared id, or existing inner ≠ incoming inner) so
 * the UI can warn without blocking.
 */
export interface ImportDecision {
  action: "create" | "associate";
  /** The canonical id (recomputed from inner — never trusts the file's id). */
  id: string;
  /** True when the file's declared id disagreed with the recomputed one. */
  idMismatch: boolean;
  /** True when an existing record's inner data differs from the incoming inner
   *  (only meaningful when `action === "associate"`). */
  dataMismatch: boolean;
}

export async function decideImport(
  incoming: RecordExport,
  existing: CalibrationRecord | null,
): Promise<ImportDecision> {
  const id = await recordId(incoming.inner);
  const idMismatch = incoming.id !== id;
  if (existing) {
    return {
      action: "associate",
      id,
      idMismatch,
      dataMismatch: !innerMatches(existing.inner, incoming.inner),
    };
  }
  return { action: "create", id, idMismatch, dataMismatch: false };
}

// ---- Nickname resolution (Welcome + selector) ------------------------------

/**
 * Resolve the nickname to show for the CONNECTED rig (Welcome window). Given the
 * connected triple hash and a map of triple docs (hash → doc), return the
 * trimmed non-empty `nickname`, else null. Pure; unit-tested.
 */
export function resolveNickname(
  connectedHash: string | null,
  tripleDocs: Readonly<Record<string, { nickname?: unknown } | undefined>>,
): string | null {
  if (!connectedHash) return null;
  const nn = tripleDocs[connectedHash]?.nickname;
  return typeof nn === "string" && nn.trim() ? nn.trim() : null;
}
