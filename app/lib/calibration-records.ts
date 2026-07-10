// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Calibration-records data model (docs/proposals/calibration-records-v2.md +
// its AS-BUILT addendum for store schema v2).
//
// A calibration RECORD is the per-camera replacement for the flat calibration
// document. BOTH kinds — EXTRINSIC (per-fovea datapoint array) and INTRINSIC
// (center-camera solve) — share one model:
//
//   • IMMUTABLE inner data (`RecordInner`) — the raw payload the record is built
//     from. This is the HASH PRE-IMAGE: the record `id` (its primary key AND
//     store filename) is a TRUNCATED SHA-256 (32 hex digits — see
//     {@link RECORD_ID_HEX}) of a canonical, key-sorted serialization of
//     `inner`. Pure + deterministic → the same payload always yields the same
//     id, across sessions/platforms, so a record imported from another rig
//     collides with an identical local one (import then just ADDS an
//     association).
//
//   • MUTABLE outer metadata (`RecordMeta`) — associations (camera-instance ⇄
//     triple bindings), a creation timestamp (latest-first ordering key), an
//     optional label, and (for aggregates) the source record ids. Editing the
//     outer metadata NEVER changes the id (only the inner data does).
//
// Records live in PER-KIND store directories, keyed by their 32-hex id:
//   • extrinsic → `["calibrate-extrinsic", <id>]`  ({@link EXTRINSIC_STORE})
//   • intrinsic → `["calibrate-intrinsic", <id>]`  ({@link INTRINSIC_STORE})
// (Schema v2 removed the flat `calibration-records/` directory; the v1→v2
// migration moved every record into its per-kind directory and truncated the
// id, and wrapped legacy `calibrate-intrinsic/<cameraKey>` CameraCalibration
// docs as intrinsic records. See `store-migrations.ts`.)
//
// This module is PURE (no store IO, no Vue, no core/): the config window, the
// orchestrator load path, and the store-migration framework all inject their
// own IO around these functions, and every function here is unit-testable with
// plain objects. `sha256` is the only async dependency (WebCrypto, available in
// both the renderer and the node/main contexts).

import { sha256 } from "./util/hash.js";
import type { ExtrinsicDataset } from "./camera-config.js";

/** The two record kinds. Also the per-kind store-directory discriminant. */
export type RecordKind = "extrinsic" | "intrinsic";

/** Store directory for extrinsic records (`["calibrate-extrinsic", <id>]`). */
export const EXTRINSIC_STORE = "calibrate-extrinsic";
/** Store directory for intrinsic records (`["calibrate-intrinsic", <id>]`). */
export const INTRINSIC_STORE = "calibrate-intrinsic";
/** Both per-kind record directories (enumerate reads them all). */
export const RECORD_STORES = [EXTRINSIC_STORE, INTRINSIC_STORE] as const;

/** The per-kind store directory a record of this kind lives under. */
export function recordStore(kind: RecordKind): string {
  return kind === "intrinsic" ? INTRINSIC_STORE : EXTRINSIC_STORE;
}

/**
 * LEGACY store directory records lived under at schema v1 (a single flat dir).
 * Retained ONLY for the shipped v0→v1 migration + its test; schema v2 moved
 * every record into its per-kind directory ({@link recordStore}). New code must
 * use {@link EXTRINSIC_STORE} / {@link INTRINSIC_STORE}.
 */
export const RECORD_STORE = "calibration-records";

// ---- Inner data (the hash pre-image) ---------------------------------------

/**
 * The IMMUTABLE inner data of an EXTRINSIC record — the hash pre-image. Keep
 * this to raw, solve-relevant data only: anything volatile or fit-derived
 * (RMS, regressions, timestamps) would make the id unstable and must live in
 * the outer metadata instead.
 */
export interface ExtrinsicInner {
  /** Discriminant + schema tag (hashed). */
  kind: "extrinsic";
  /** The raw per-fovea datapoint array, verbatim from calibrate-extrinsic
   *  (`createDataSet`). The array ORDER is significant and preserved through
   *  the hash (arrays are not reordered by canonicalization). */
  dataset: ExtrinsicDataset;
}

/**
 * The IMMUTABLE inner data of an INTRINSIC record — the hash pre-image. Holds
 * the `CameraCalibration` SOLVE PAYLOAD (`sensor_size`, `camera_matrix`,
 * `dist_coeffs`, `rvecs`, `tvecs`, and optionally `rms`) MINUS the volatile
 * `date` (which becomes `outer.created`). The Mats are `Float64Array`s carrying
 * `shape`/`channels` expando props; `canonicalize` folds them into the same
 * canonical form the store codec writes to disk, so the id is stable across the
 * wire codec and the plain-JSON migration runner (see {@link canonicalize}).
 * Typed as an opaque record to keep this module free of a `core/` dependency.
 */
export interface IntrinsicInner {
  kind: "intrinsic";
  /** The `CameraCalibration` payload without `date`. */
  calibration: Record<string, unknown>;
}

/** A record's immutable inner data (discriminated by `kind`). */
export type RecordInner = ExtrinsicInner | IntrinsicInner;

/**
 * One binding of a record to a camera instance within a triple. A record may
 * carry MANY (multi-association across rigs). `tripleHash` is optional: legacy
 * migrations bind by `cameraKey` alone (no live triple hash was available),
 * and the UI then matches such a record to a triple whose live L/C/R camera key
 * equals `cameraKey` — see {@link recordBelongsToTriple}.
 */
export interface Association {
  /** Camera identity key (`vendor_model_serial`, `getCameraKey`) this binding
   *  targets — the CAMERA the record calibrates in the bound triple (an eye for
   *  extrinsic, the center for intrinsic). */
  cameraKey: string;
  /** The triple hash this binding was created under (`["triples", <hash>]`).
   *  Absent on legacy-migrated bindings (matched by `cameraKey` instead). */
  tripleHash?: string;
  /** Advisory role within the triple at binding time (`"L"` / `"C"` / `"R"`). */
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

/** A full record document (`[recordStore(inner.kind), <id>]`). */
export interface CalibrationRecord {
  /** Content-hash id (also the store filename). Equals `recordId(inner)`. */
  id: string;
  inner: RecordInner;
  outer: RecordMeta;
}

// ---- Content-hash identity -------------------------------------------------

/**
 * Record-id length in hex digits. A full SHA-256 is 64 hex (256 bits) — too
 * long for a filename/key; we TRUNCATE to the first 32 hex digits (128 bits).
 * Collision odds are negligible: a birthday collision needs ~2^64 records, far
 * beyond any rig's lifetime store (and an accidental collision on DIFFERENT
 * data is caught on import by the inner-data compare, see {@link decideImport}).
 * ALL record + triple ids use this width.
 */
export const RECORD_ID_HEX = 32;

const RECORD_ID_RE = new RegExp(`^[0-9a-f]{${RECORD_ID_HEX}}$`);
const FULL_HASH_RE = /^[0-9a-f]{64}$/;

/** Whether a store-key name is a record/triple id (32 lowercase hex digits) —
 *  distinguishes hash-keyed record files from legacy `<cameraKey>` docs (which
 *  carry non-hex vendor/model prefixes) and `.raw` analysis artifacts. */
export function isRecordId(name: string): boolean {
  return RECORD_ID_RE.test(name);
}

/** Truncate a full SHA-256 hex digest to the stable {@link RECORD_ID_HEX}-hex
 *  id. A pass-through if already ≤ the target width. */
export function truncateHashHex(fullHex: string): string {
  return fullHex.slice(0, RECORD_ID_HEX);
}

/** The stable 32-hex id for a canonical string (truncated SHA-256). The single
 *  hashing primitive behind BOTH record ids and triple ids. */
export async function stableHash(canonical: string): Promise<string> {
  return truncateHashHex(await sha256(canonical));
}

/**
 * Canonical, deterministic serialization for hashing: object keys are sorted
 * recursively (so key insertion order never affects the id) while ARRAY order
 * is preserved (datapoint order is meaningful). `undefined` values and missing
 * optional fields are omitted identically (JSON semantics).
 *
 * TypedArrays / ArrayBuffers (an intrinsic record's Mats) fold into the SAME
 * `{ type, buffer: <base64 of the whole buffer>, props }` shape the store codec
 * (`store-codec.ts` replacer) writes to disk — so a live `Float64Array`-with-
 * props and its on-disk `{type,buffer,props}` encoding canonicalize IDENTICALLY.
 * That is the contract that lets the plain-JSON migration runner (which sees the
 * encoded form) and the codec-reviving app (which sees real Mats) agree on an
 * intrinsic record's id. Pure; unit-tested for key-order / nesting / typed
 * values / typed-array stability.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** Base64 of a buffer's WHOLE byte range (mirrors store-codec's `toBase64`, so
 *  the canonical typed-array form byte-matches the on-disk encoding). */
function bufferBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** The writable+enumerable, non-index own props of a typed array (a Mat's
 *  `shape`/`channels`) — mirrors store-codec's `ownProperties`. `undefined`
 *  when there are none (so the `props` key is dropped, matching the codec). */
function typedArrayProps(value: object): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (/^\d+$/.test(key)) continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d && d.writable && d.enumerable) {
      out[key] = (value as Record<string, unknown>)[key];
      any = true;
    }
  }
  return any ? out : undefined;
}

function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  // Fold binary payloads into the codec's canonical `{type,buffer,props}` shape,
  // then re-sort it as a plain object (so keys sort + props recurse, and a value
  // ALREADY in that encoded form lands on the identical string).
  if (v instanceof ArrayBuffer)
    return sortDeep({ type: "ArrayBuffer", buffer: bufferBase64(v), props: typedArrayProps(v) });
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const ta = v as ArrayBufferView & { constructor: { name: string } };
    return sortDeep({
      type: ta.constructor.name,
      buffer: bufferBase64(ta.buffer),
      props: typedArrayProps(v),
    });
  }
  if (Array.isArray(v)) return v.map(sortDeep);
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) {
    if (src[k] === undefined) continue; // match JSON's undefined-omission
    out[k] = sortDeep(src[k]);
  }
  return out;
}

/** The content-hash id (primary key) for a piece of inner data. Same inner →
 *  same 32-hex id, forever. */
export function recordId(inner: RecordInner): Promise<string> {
  return stableHash(canonicalize(inner));
}

/** Build the immutable inner data for an extrinsic datapoint array. */
export function extrinsicInner(dataset: ExtrinsicDataset): ExtrinsicInner {
  return { kind: "extrinsic", dataset };
}

/**
 * Build the immutable inner data for an intrinsic solve. Strips the volatile
 * `date` (→ `outer.created`) so it never perturbs the id; everything else in
 * the `CameraCalibration` payload (Mats + `rms`) is the hash pre-image.
 */
export function intrinsicInner(calibration: Record<string, unknown>): IntrinsicInner {
  const rest: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(calibration)) if (k !== "date") rest[k] = val;
  return { kind: "intrinsic", calibration: rest };
}

/** Assemble a fresh record from inner data + outer metadata (id derived). */
export async function makeRecord(
  inner: RecordInner,
  outer: RecordMeta,
): Promise<CalibrationRecord> {
  return { id: await recordId(inner), inner, outer };
}

// ---- Legacy migration ------------------------------------------------------

/**
 * Wrap a LEGACY flat extrinsic dataset (`["calibrate-extrinsic", <cameraKey>]`
 * = a bare `ExtrinsicData[]`) as a record with ZERO data loss. Pure +
 * idempotent by construction (the id is a function of the dataset only).
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
      associations: [{ cameraKey, tripleHash: meta.tripleHash, role: meta.role }],
    },
  };
}

/**
 * Wrap a LEGACY intrinsic `CameraCalibration` doc (`["calibrate-intrinsic",
 * <cameraKey>]`) as an intrinsic record. `inner` is the solve payload minus the
 * volatile `date`; `created` comes from the caller (the doc's `date`, else the
 * file mtime). One synthesized association binds the record to the owning
 * (center) camera. Pure + idempotent by construction.
 */
export async function migrateLegacyIntrinsic(
  cameraKey: string,
  calibration: Record<string, unknown>,
  meta: { created: string; role?: string; label?: string },
): Promise<CalibrationRecord> {
  const inner = intrinsicInner(calibration);
  return {
    id: await recordId(inner),
    inner,
    outer: {
      created: meta.created,
      label: meta.label,
      associations: [{ cameraKey, role: meta.role }],
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
 * is now ORPHANED (0 associations → the caller trashes the file).
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
 * binding whose `cameraKey` is one of the triple's live L/C/R camera keys
 * (`liveKeys`).
 */
export function recordBelongsToTriple(
  rec: CalibrationRecord,
  tripleHash: string,
  liveKeys: readonly string[],
): boolean {
  return rec.outer.associations.some((a) =>
    a.tripleHash != null ? a.tripleHash === tripleHash : liveKeys.includes(a.cameraKey),
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

// ---- Aggregation (extrinsic only) ------------------------------------------

/**
 * Aggregate N EXTRINSIC records into a NEW record whose inner dataset is the
 * CONCATENATION of the sources' datapoint arrays (in the given order). The new
 * record gets a fresh content-hash id, records the source ids in `outer.sources`
 * (provenance), and takes the caller-supplied association. The SOURCES ARE NOT
 * MUTATED — aggregation is additive.
 *
 * Aggregation is meaningful only for extrinsic records (intrinsic records hold a
 * solved calibration, not a concatenable capture array) — mixing kinds, or any
 * intrinsic input, throws. The config UI guards against offering it cross-kind.
 */
export async function aggregateRecords(
  records: readonly CalibrationRecord[],
  meta: { created: string; label?: string; association?: Association },
): Promise<CalibrationRecord> {
  if (records.some((r) => r.inner.kind !== "extrinsic"))
    throw new Error("aggregateRecords: only extrinsic records can be aggregated");
  const dataset: ExtrinsicDataset = records.flatMap(
    (r) => (r.inner as ExtrinsicInner).dataset,
  );
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

/** Total datapoint count for a record's inner data — the extrinsic datapoint
 *  count, or the intrinsic view count (`rvecs.length`). (List-row summary.) */
export function datapointCount(rec: CalibrationRecord): number {
  if (rec.inner.kind === "extrinsic") return rec.inner.dataset.length;
  const rvecs = (rec.inner.calibration as { rvecs?: unknown }).rvecs;
  return Array.isArray(rvecs) ? rvecs.length : 0;
}

/** Latest-first ordering (newest `created` on top). Stable; pure. */
export function orderRecordsLatestFirst(
  records: readonly CalibrationRecord[],
): CalibrationRecord[] {
  return [...records].sort((a, b) => b.outer.created.localeCompare(a.outer.created));
}

/**
 * Resolve the ACTIVE extrinsic dataset a camera should calibrate with: the
 * LATEST extrinsic record (by `created`) associated with `cameraKey`. Null when
 * no extrinsic record is bound. Pure; unit-tested.
 */
export function resolveActiveDataset(
  records: readonly CalibrationRecord[],
  cameraKey: string,
): ExtrinsicDataset | null {
  const bound = records.filter(
    (r) =>
      r.inner.kind === "extrinsic" &&
      r.outer.associations.some((a) => a.cameraKey === cameraKey),
  );
  if (bound.length === 0) return null;
  return (orderRecordsLatestFirst(bound)[0]!.inner as ExtrinsicInner).dataset;
}

/**
 * Resolve the ACTIVE intrinsic calibration a camera should use: the LATEST
 * intrinsic record (by `created`) associated with `cameraKey`, as `{ calibration
 * (solve payload, no date), created }`. Null when none is bound — the loader
 * then falls back to the legacy flat doc. Pure; unit-tested.
 */
export function resolveActiveIntrinsic(
  records: readonly CalibrationRecord[],
  cameraKey: string,
): { calibration: Record<string, unknown>; created: string } | null {
  const bound = records.filter(
    (r) =>
      r.inner.kind === "intrinsic" &&
      r.outer.associations.some((a) => a.cameraKey === cameraKey),
  );
  if (bound.length === 0) return null;
  const latest = orderRecordsLatestFirst(bound)[0]!;
  return {
    calibration: (latest.inner as IntrinsicInner).calibration,
    created: latest.outer.created,
  };
}

// ---- Import / export bundles ----------------------------------------------

/** Wire schema tag for a single-record export file (EXTERNAL mode). */
export const RECORD_EXPORT_SCHEMA = "fovea-calibration-record@1";
/** Wire schema tag for a device-config bundle export file. */
export const DEVICE_EXPORT_SCHEMA = "fovea-device-config@1";

/**
 * A record as written to an EXTERNAL JSON file: the immutable inner data plus
 * the id and provenance, but WITHOUT associations (those are rig-local and are
 * re-created on import against the importing triple). `role` is advisory.
 */
export interface RecordExport {
  id: string;
  inner: RecordInner;
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
 * record with associations stripped. The caller supplies the records already
 * filtered to this triple.
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
 *  hash collision that isn't actually the same data. */
export function innerMatches(a: RecordInner, b: RecordInner): boolean {
  return canonicalize(a) === canonicalize(b);
}

/**
 * Decide what importing one record should do against the current store. Pure —
 * the caller performs the resulting store write. When a record with the
 * recomputed id already exists, the decision is `associate`; otherwise `create`.
 * `idMismatch`/`dataMismatch` flag a corrupt bundle so the UI can warn without
 * blocking.
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

// ---- Triple hash re-key (v1→v2 migration helper) ---------------------------

/**
 * Re-key a legacy FULL-64-hex triple hash to the stable 32-hex id (a plain
 * truncation, since the id is a truncated SHA-256 of the same `{L,C,R}`
 * pre-image). A value that is already 32-hex, or a non-hash string, passes
 * through unchanged (idempotent). Used by the v1→v2 migration to re-key both
 * `["triples", <hash>]` keys and `association.tripleHash` fields.
 */
export function reKeyTripleHash<T extends string | undefined>(hash: T): T {
  if (hash != null && FULL_HASH_RE.test(hash)) return truncateHashHex(hash) as T;
  return hash;
}
