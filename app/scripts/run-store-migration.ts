// One-off driver to run the store-schema migration framework against a real
// store tree WITHOUT launching Electron (esbuild-bundled to ESM, run with node).
// Uses a plain-fs MigrationFs (the migration's data is pure JSON numbers, so the
// store codec is unnecessary here). No git — the snapshot is done manually per
// the store git protocol. Verifies: version transition, idempotency (second run
// is a no-op), and that every record's on-disk id re-derives from its inner data.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  readSchemaVersion,
  runMigrations,
  type MigrationFs,
} from "../lib/store-migrations.js";
import { RECORD_STORE, recordId, type CalibrationRecord } from "../lib/calibration-records.js";

const ROOT = resolve(process.env.FOVEA_DATA_PATH ?? process.cwd(), "store");
const pathOf = (segs: string[]) => resolve(ROOT, ...segs) + ".json";

const fs: MigrationFs = {
  async read<T>(segments: string[], fallback: T): Promise<T> {
    const p = pathOf(segments);
    if (!existsSync(p)) return fallback;
    const t = (await readFile(p)).toString();
    if (t.trim() === "") return fallback;
    try {
      return JSON.parse(t) as T;
    } catch {
      return fallback;
    }
  },
  async write(segments, value) {
    const p = pathOf(segments);
    const dir = dirname(p);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, p);
  },
  async clear(segments) {
    await rm(pathOf(segments), { force: true });
  },
  async list(...segments) {
    const dir = resolve(ROOT, ...segments);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir);
    const out: string[] = [];
    for (const e of entries) {
      const s = await stat(resolve(dir, e));
      if (!s.isDirectory() && e.endsWith(".json")) out.push(e.replace(/\.json$/, ""));
    }
    return out;
  },
  async stat(segments) {
    try {
      const s = await stat(pathOf(segments));
      return { mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  },
};

async function main() {
  console.log(`[migrate] store root: ${ROOT}`);
  console.log(`[migrate] version before: ${await readSchemaVersion(fs)}`);

  const res1 = await runMigrations(fs);
  console.log(`[migrate] run 1: from v${res1.from} → v${res1.to}, applied=[${res1.applied.join(", ")}]`);
  console.log(`[migrate] reports:`, JSON.stringify(res1.reports));

  const res2 = await runMigrations(fs);
  console.log(`[migrate] run 2 (idempotency): applied=[${res2.applied.join(", ")}] (expect empty)`);

  const ids = await fs.list(RECORD_STORE);
  console.log(`[migrate] records: ${ids.length}`);
  for (const id of ids) {
    const rec = await fs.read<CalibrationRecord | null>([RECORD_STORE, id], null);
    if (!rec) continue;
    const recomputed = await recordId(rec.inner);
    console.log(
      `  ${id.slice(0, 12)}… dp=${rec.inner.dataset.length} idMatch=${recomputed === id} ` +
        `created=${rec.outer.created} assoc=${JSON.stringify(rec.outer.associations)}`,
    );
  }
  const leftover = await fs.list("calibrate-extrinsic");
  console.log(`[migrate] remaining calibrate-extrinsic entries: [${leftover.join(", ")}]`);
}

void main();
