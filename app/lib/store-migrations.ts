// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Store-schema migration framework: MAIN runs migrations at StoreMain construction,
// before any client is served. An ordered `MIGRATIONS` registry advances the reserved
// `["schema"]` version, snapshotting the store repo (injected git hook) before and
// after. To evolve: APPEND a `{from,to}` step + bump STORE_SCHEMA_VERSION; NEVER mutate
// a shipped migration, and keep every step idempotent (converge / derive ids from
// content) — tests assert run-twice is a no-op.
// spec: docs/spec/store.md#store-migrations

import {
  INTRINSIC_STORE,
  RECORD_STORES,
  RECORD_STORE,
  addAssociation,
  isRecordId,
  migrateLegacyExtrinsic,
  migrateLegacyIntrinsic,
  reKeyTripleHash,
  recordId,
  recordStore,
  type CalibrationRecord,
  type RecordKind,
} from "./calibration-records.js";
import type { ExtrinsicDataset } from "./camera-config.js";

/** The version this build targets. Bump when appending a migration. */
export const STORE_SCHEMA_VERSION = 2;

/** The reserved doc holding the on-disk schema version. */
export const SCHEMA_DOC = ["schema"];

/** The disk surface a migration operates over — the store fs primitives plus an
 *  optional `stat` (for file mtime → legacy timestamps). Satisfied by
 *  `app/orchestrator/store.ts` in production and by an in-memory fake in tests. */
export interface MigrationFs {
  read<T>(segments: string[], fallback: T): Promise<T>;
  write(segments: string[], value: unknown): Promise<void>;
  clear(segments: string[]): Promise<void>;
  list(...segments: string[]): Promise<string[]>;
  /** File modification time (ms since epoch) for a doc, or null when absent /
   *  unsupported. Used only to date legacy records; a missing stat degrades to
   *  the migration clock. */
  stat?(segments: string[]): Promise<{ mtimeMs: number } | null>;
}

export interface MigrationCtx {
  /** Deterministic clock (ISO-8601) — injectable so tests are stable. */
  now(): string;
}

/** Per-migration stats (surfaced in the boot log + the worker report). */
export type MigrationReport = Record<string, unknown>;

export interface Migration {
  readonly from: number;
  readonly to: number;
  readonly name: string;
  run(fs: MigrationFs, ctx: MigrationCtx): Promise<MigrationReport>;
}

/** When the framework snapshots the store repo. `before` fires once there is
 *  pending work (pre-mutation); `after` fires once the new version is written.
 *  Injected so the git shell stays out of this pure module. */
export type SnapshotHook = (
  phase: "before" | "after",
  info: { from: number; to: number },
) => Promise<void>;

// ---- Migration 0 → 1: calibration-records-v2 -------------------------------

/**
 * Wrap every legacy flat extrinsic dataset (`["calibrate-extrinsic",
 * <cameraKey>]` = a bare `ExtrinsicData[]`) as a content-hashed record under
 * `["calibration-records", <id>]`, synthesizing a `cameraKey` association and a
 * `created` timestamp from the file mtime, then remove the legacy doc (the
 * layout moves). Idempotent: the id is a pure function of the dataset, so a
 * re-run collides on the existing record (union the association) rather than
 * duplicating; and once the legacy doc is gone, subsequent runs find nothing.
 *
 * `.raw`-suffixed extrinsic docs are ANALYSIS artifacts (not schema documents)
 * and are left verbatim on disk — never migrated, never deleted.
 */
async function migrateExtrinsicToRecords(
  fs: MigrationFs,
  ctx: MigrationCtx,
): Promise<MigrationReport> {
  const keys = await fs.list("calibrate-extrinsic");
  let created = 0;
  let associated = 0;
  let skipped = 0;
  for (const key of keys) {
    if (key.endsWith(".raw")) {
      skipped++;
      continue; // analysis artifact — leave verbatim
    }
    const dataset = await fs.read<ExtrinsicDataset | null>(
      ["calibrate-extrinsic", key],
      null,
    );
    if (!Array.isArray(dataset) || dataset.length === 0) {
      skipped++;
      continue;
    }
    const mtime = fs.stat ? await fs.stat(["calibrate-extrinsic", key]) : null;
    const createdIso = mtime ? new Date(mtime.mtimeMs).toISOString() : ctx.now();
    const rec = await migrateLegacyExtrinsic(key, dataset, { created: createdIso });
    const existing = await fs.read<CalibrationRecord | null>(
      ["calibration-records", rec.id],
      null,
    );
    if (existing && existing.inner) {
      // Idempotent re-run (or two cameras that somehow share identical data):
      // union the association onto the existing record.
      const merged = addAssociation(existing, rec.outer.associations[0]!);
      if (merged !== existing) {
        await fs.write(["calibration-records", rec.id], merged);
        associated++;
      }
    } else {
      await fs.write(["calibration-records", rec.id], rec);
      created++;
    }
    // Move to the new layout: drop the legacy doc (loadExtrinsic reads records
    // now; the legacy path remains only as an un-migrated-store fallback).
    await fs.clear(["calibrate-extrinsic", key]);
  }
  return { created, associated, skipped };
}

const migration0to1: Migration = {
  from: 0,
  to: 1,
  name: "calibration-records-v2",
  run: migrateExtrinsicToRecords,
};

// ---- Migration 1 → 2: per-kind record stores + 32-hex ids ------------------

/** Whether a doc looks like a legacy `CameraCalibration` (a `camera_matrix`
 *  present, however encoded), distinguishing it from a wrapped record. */
function isCameraCalibration(v: unknown): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === "object" &&
    (v as Record<string, unknown>).camera_matrix != null &&
    (v as Record<string, unknown>).inner == null
  );
}

/** Best-effort ISO-8601 from a `date` value that may be a `Date`, an ISO string,
 *  or the store codec's `{type:"Date", date}` shape (plain-JSON migration
 *  runner). Null when unrecognized. */
function isoFromDate(d: unknown): string | null {
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d.toISOString();
  if (typeof d === "string") {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  if (
    d &&
    typeof d === "object" &&
    (d as { type?: unknown }).type === "Date" &&
    typeof (d as { date?: unknown }).date === "string"
  ) {
    return (d as { date: string }).date;
  }
  return null;
}

/** Re-key any legacy 64-hex `association.tripleHash` to the 32-hex id. Returns a
 *  NEW record only when something changed (else the same object). */
function reKeyRecordAssociations(
  rec: CalibrationRecord,
): { record: CalibrationRecord; changed: boolean } {
  let changed = false;
  const associations = rec.outer.associations.map((a) => {
    const th = reKeyTripleHash(a.tripleHash);
    if (th !== a.tripleHash) changed = true;
    return th === a.tripleHash ? a : { ...a, tripleHash: th };
  });
  if (!changed) return { record: rec, changed };
  return { record: { ...rec, outer: { ...rec.outer, associations } }, changed };
}

/** Write a record into its per-kind directory under its recomputed 32-hex id,
 *  UNIONING onto an existing record at that id (idempotent). Associations are
 *  re-keyed to 32-hex on the way in. */
async function placeRecord(
  fs: MigrationFs,
  rec: CalibrationRecord,
  kind: RecordKind,
): Promise<void> {
  const dir = recordStore(kind);
  const newId = await recordId(rec.inner);
  const { record: reKeyed } = reKeyRecordAssociations({ ...rec, id: newId });
  const existing = await fs.read<CalibrationRecord | null>([dir, newId], null);
  if (existing && existing.inner) {
    let merged = existing;
    for (const a of reKeyed.outer.associations) merged = addAssociation(merged, a);
    if (merged !== existing) await fs.write([dir, newId], merged);
  } else {
    await fs.write([dir, newId], reKeyed);
  }
}

/**
 * v1 → v2. Restructures calibration-record storage:
 *
 *   1. MOVE every flat `["calibration-records", <id64>]` record into its
 *      per-kind directory (`["calibrate-extrinsic"|"calibrate-intrinsic",
 *      <id32>]`), recomputing the id to 32 hex and re-keying any legacy 64-hex
 *      association `tripleHash`; then clear the flat doc.
 *   2. WRAP each legacy `["calibrate-intrinsic", <cameraKey>]` `CameraCalibration`
 *      doc as an intrinsic record (inner = the solve payload minus `date`;
 *      association = the center camera; `created` from `date`/mtime); then clear
 *      the legacy doc. Camera keys carry non-hex vendor/model prefixes, so they
 *      are distinguishable from 32-hex record ids (asserted).
 *   3. RE-KEY any 64-hex `association.tripleHash` still on a per-kind record
 *      (idempotency belt-and-braces on top of step 1).
 *   4. RE-KEY `["triples", <hash64>]` docs to `["triples", <hash32>]` (a plain
 *      truncation — the id is a truncated SHA-256 of the same `{L,C,R}`).
 *
 * `.raw` analysis artifacts in the per-kind directories are left VERBATIM.
 * Idempotent: recomputed ids are pure over content, wrapped intrinsic docs
 * become record-id-keyed (skipped on re-run), and re-keys converge.
 */
async function migrateToPerKindRecords(
  fs: MigrationFs,
  ctx: MigrationCtx,
): Promise<MigrationReport> {
  let extrinsicMoved = 0;
  let intrinsicMoved = 0;
  let intrinsicWrapped = 0;
  let triplesReKeyed = 0;
  let assocReKeyed = 0;
  let skipped = 0;

  // 1. Move flat calibration-records/* into the per-kind directories.
  for (const name of await fs.list(RECORD_STORE)) {
    const rec = await fs.read<CalibrationRecord | null>([RECORD_STORE, name], null);
    if (!rec || !rec.inner) {
      skipped++;
      continue;
    }
    const kind: RecordKind = rec.inner.kind === "intrinsic" ? "intrinsic" : "extrinsic";
    await placeRecord(fs, rec, kind);
    await fs.clear([RECORD_STORE, name]);
    if (kind === "intrinsic") intrinsicMoved++;
    else extrinsicMoved++;
  }

  // 2. Wrap legacy intrinsic <cameraKey> docs as intrinsic records.
  for (const name of await fs.list(INTRINSIC_STORE)) {
    if (name.endsWith(".raw")) {
      skipped++;
      continue; // analysis artifact — leave verbatim
    }
    // Distinguishability invariant: 32-hex names are records (already migrated,
    // or moved in step 1) — never legacy camera-key docs (which carry non-hex
    // vendor/model prefixes). Skipping them keeps the step idempotent AND
    // guarantees a camera key is never mistaken for a record id.
    if (isRecordId(name)) continue;
    const cal = await fs.read<Record<string, unknown> | null>(
      [INTRINSIC_STORE, name],
      null,
    );
    if (!isCameraCalibration(cal)) {
      skipped++;
      continue;
    }
    const mtime = fs.stat ? await fs.stat([INTRINSIC_STORE, name]) : null;
    const created =
      isoFromDate(cal.date) ??
      (mtime ? new Date(mtime.mtimeMs).toISOString() : ctx.now());
    const rec = await migrateLegacyIntrinsic(name, cal, { created });
    await placeRecord(fs, rec, "intrinsic");
    await fs.clear([INTRINSIC_STORE, name]);
    intrinsicWrapped++;
  }

  // 3. Re-key any 64-hex association tripleHash still present (belt-and-braces).
  for (const dir of RECORD_STORES) {
    for (const id of (await fs.list(dir)).filter(isRecordId)) {
      const rec = await fs.read<CalibrationRecord | null>([dir, id], null);
      if (!rec || !rec.inner) continue;
      const { record, changed } = reKeyRecordAssociations(rec);
      if (changed) {
        await fs.write([dir, id], record);
        assocReKeyed++;
      }
    }
  }

  // 4. Re-key triple docs 64-hex → 32-hex.
  for (const name of await fs.list("triples")) {
    const newKey = reKeyTripleHash(name);
    if (newKey === name) continue; // already 32-hex or non-hash
    const doc = await fs.read<unknown>(["triples", name], null);
    const existing = await fs.read<unknown>(["triples", newKey], null);
    if (existing == null) await fs.write(["triples", newKey], doc);
    await fs.clear(["triples", name]);
    triplesReKeyed++;
  }

  return {
    extrinsicMoved,
    intrinsicMoved,
    intrinsicWrapped,
    triplesReKeyed,
    assocReKeyed,
    skipped,
  };
}

const migration1to2: Migration = {
  from: 1,
  to: 2,
  name: "per-kind-record-stores",
  run: migrateToPerKindRecords,
};

/** The ORDERED migration registry. Append new steps here (see the header
 *  contract) — never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [migration0to1, migration1to2];

// ---- Runner ----------------------------------------------------------------

/** Read the on-disk schema version (absent / non-numeric ⇒ 0 = legacy). */
export async function readSchemaVersion(fs: MigrationFs): Promise<number> {
  const doc = await fs.read<{ version?: unknown }>(SCHEMA_DOC, {});
  return typeof doc.version === "number" && Number.isFinite(doc.version)
    ? doc.version
    : 0;
}

export interface MigrationRunResult {
  from: number;
  to: number;
  /** Names of the migrations applied, in order (empty when already current). */
  applied: string[];
  /** Per-migration reports, keyed by migration name. */
  reports: Record<string, MigrationReport>;
}

/**
 * Bring the store up to {@link STORE_SCHEMA_VERSION}. Reads the version, applies
 * pending migrations in `from → to` order, and writes the new version. When any
 * work is pending, `snapshot("before", …)` runs first and `snapshot("after",
 * …)` last (git-boundary injection; a throwing/offline snapshot must be caught
 * by the caller's hook — it never blocks the migration itself here). A no-op
 * when already current (no snapshot, no version write).
 */
export async function runMigrations(
  fs: MigrationFs,
  opts: {
    ctx?: MigrationCtx;
    snapshot?: SnapshotHook;
    target?: number;
  } = {},
): Promise<MigrationRunResult> {
  const ctx = opts.ctx ?? { now: () => new Date().toISOString() };
  const target = opts.target ?? STORE_SCHEMA_VERSION;
  const from = await readSchemaVersion(fs);
  const applied: string[] = [];
  const reports: Record<string, MigrationReport> = {};

  if (from >= target) return { from, to: from, applied, reports };

  if (opts.snapshot) await opts.snapshot("before", { from, to: target });

  let current = from;
  // Chain steps: at each version, find the migration that starts there.
  while (current < target) {
    const step = MIGRATIONS.find((m) => m.from === current);
    if (!step) {
      throw new Error(
        `store-migrations: no migration from version ${current} (target ${target})`,
      );
    }
    reports[step.name] = await step.run(fs, ctx);
    applied.push(step.name);
    current = step.to;
    await fs.write(SCHEMA_DOC, { version: current });
  }

  if (opts.snapshot) await opts.snapshot("after", { from, to: current });

  return { from, to: current, applied, reports };
}
