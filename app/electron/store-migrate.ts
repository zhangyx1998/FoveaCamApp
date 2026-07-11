// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Main-side driver for the store-schema migration framework. Runs at boot BEFORE
// any store client is served (no client observes a half-migrated tree), wiring
// the pure framework to the real store fs + a GIT snapshot boundary over the
// store repo (a commit before + after each migration — the pre-migration commit
// is the safety net). Push is best-effort; offline / non-repo / migration
// failure all log + continue, never crash boot.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat as fsStat } from "node:fs/promises";
import { resolve } from "node:path";
import * as fsStore from "../orchestrator/store.js";
import {
  runMigrations,
  type MigrationFs,
  type SnapshotHook,
} from "@lib/store-migrations";

const execFileP = promisify(execFile);

/** The migration fs surface over the real store primitives + a file-mtime
 *  `stat` (legacy records inherit their file's mtime as `created`). */
function migrationFs(dataPath: string): MigrationFs {
  return {
    read: (segments, fallback) => fsStore.read(segments, fallback),
    write: (segments, value) => fsStore.write(segments, value),
    clear: (segments) => fsStore.clear(segments),
    list: (...segments) => fsStore.list(...segments),
    async stat(segments) {
      try {
        const p = resolve(dataPath, "store", ...segments) + ".json";
        const s = await fsStat(p);
        return { mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    },
  };
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileP("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Auto-snapshot the store repo around a migration (best-effort). Commit may be
 *  empty (nothing staged) — treated as success; push may fail offline — logged,
 *  never thrown. */
function gitSnapshot(dataPath: string): SnapshotHook {
  const storeDir = resolve(dataPath, "store");
  return async (phase, info) => {
    if (!(await isGitRepo(storeDir))) {
      console.warn(`[store-migrate] ${storeDir} is not a git repo — skipping ${phase} snapshot`);
      return;
    }
    const message =
      phase === "before"
        ? `snapshot: pre store-migration v${info.from}`
        : `migrate: store schema v${info.to}`;
    try {
      await execFileP("git", ["-C", storeDir, "add", "-A"]);
      await execFileP("git", ["-C", storeDir, "commit", "-m", message]);
    } catch (e) {
      // Nothing to commit / commit hook failure — non-fatal.
      console.warn(`[store-migrate] ${phase} commit skipped: ${e}`);
    }
    try {
      await execFileP("git", ["-C", storeDir, "push"]);
    } catch (e) {
      console.warn(`[store-migrate] ${phase} push skipped (offline?): ${e}`);
    }
  };
}

/**
 * Bring the store up to the current schema version at boot. Never throws — a
 * failure is logged (the pre-migration git snapshot is the recovery path) so
 * the app still launches. Returns quietly when already current.
 */
export async function migrateStoreOnBoot(): Promise<void> {
  const dataPath = process.env.FOVEA_DATA_PATH ?? process.cwd();
  try {
    const res = await runMigrations(migrationFs(dataPath), {
      snapshot: gitSnapshot(dataPath),
    });
    if (res.applied.length)
      console.log(
        `[store-migrate] v${res.from} → v${res.to}: ${res.applied.join(", ")}`,
        res.reports,
      );
  } catch (e) {
    console.error(`[store-migrate] migration FAILED (store left at prior version): ${e}`);
  }
}
