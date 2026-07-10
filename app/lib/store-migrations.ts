// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Store-schema migration framework (docs/proposals/calibration-records-v2.md
// §Migration framework). MAIN owns the config store (692f0e3), so migrations
// run in MAIN at `StoreMain` construction — BEFORE any renderer or orchestrator
// client is served, so no client ever observes a half-migrated tree.
//
// ── The durable contract (read before adding a migration) ───────────────────
// The store carries a SCHEMA VERSION in the reserved doc `["schema"]`
// (`store/schema.json` → `{ version }`). An unversioned/legacy tree = version 0.
// `MIGRATIONS` is an ORDERED registry of `(from → to)` steps. On boot:
//
//   1. read the on-disk version;
//   2. if it is behind `STORE_SCHEMA_VERSION`, SNAPSHOT the store repo (a git
//      commit; push is best-effort — offline must not block boot), then
//   3. apply each pending migration in order (each idempotent + pure over the
//      injected fs surface), then
//   4. write the new version and SNAPSHOT the migrated result.
//
// To evolve the schema, APPEND a migration `{ from: N, to: N+1, … }` and bump
// `STORE_SCHEMA_VERSION` — never mutate a shipped migration (a user's tree may
// already have run it). Each migration MUST be safe to re-run: the framework
// won't re-run a step once the version advances, but tests assert run-twice is a
// no-op regardless, so write the step to converge (check-before-write / derive
// ids from content).
//
// The git snapshot boundary is INJECTED (`SnapshotHook`) so this module stays
// pure + unit-testable — the real git shell lives in main (store-main.ts) and is
// exercised only in production; the decision logic (when to snapshot, ordered
// application, idempotency) is what the tests cover.

import {
  addAssociation,
  migrateLegacyExtrinsic,
  type CalibrationRecord,
} from "./calibration-records.js";
import type { ExtrinsicDataset } from "./camera-config.js";

/** The version this build targets. Bump when appending a migration. */
export const STORE_SCHEMA_VERSION = 1;

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

/** The ORDERED migration registry. Append new steps here (see the header
 *  contract) — never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [migration0to1];

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
