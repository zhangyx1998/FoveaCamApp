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
import {
  RECORD_STORES,
  isRecordId,
  recordId,
  type CalibrationRecord,
} from "../lib/calibration-records.js";

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

  for (const dir of RECORD_STORES) {
    const names = await fs.list(dir);
    const recordNames = names.filter(isRecordId);
    const nonRecord = names.filter((n) => !isRecordId(n));
    console.log(`[migrate] ${dir}: ${recordNames.length} record(s); non-record=[${nonRecord.join(", ")}]`);
    for (const id of recordNames) {
      const rec = await fs.read<CalibrationRecord | null>([dir, id], null);
      if (!rec) continue;
      const recomputed = await recordId(rec.inner);
      const count =
        rec.inner.kind === "extrinsic"
          ? rec.inner.dataset.length
          : Array.isArray((rec.inner.calibration as { rvecs?: unknown }).rvecs)
            ? ((rec.inner.calibration as { rvecs: unknown[] }).rvecs).length
            : 0;
      console.log(
        `  ${dir}/${id} kind=${rec.inner.kind} n=${count} id32=${/^[0-9a-f]{32}$/.test(id)} ` +
          `idMatch=${recomputed === id} created=${rec.outer.created} ` +
          `assoc=${JSON.stringify(rec.outer.associations)}`,
      );
    }
  }
  const triples = await fs.list("triples");
  console.log(
    `[migrate] triples: ${triples.map((t) => `${t}(${/^[0-9a-f]{32}$/.test(t) ? "32" : /^[0-9a-f]{64}$/.test(t) ? "64" : "?"})`).join(", ")}`,
  );
  const legacyRecords = await fs.list("calibration-records");
  console.log(`[migrate] remaining calibration-records entries: [${legacyRecords.join(", ")}]`);
}

void main();
