// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Internal filesystem primitives for `store-hub.ts`. Do not import this from
// sessions or orchestrator helpers; route reads/writes through store-hub so the
// in-memory cache, write counts, and renderer notifications stay authoritative.
// Reads/writes the same on-disk JSON files as the renderer `Store` (same path
// layout + codec), but without Vue reactivity or `ipcRenderer`. The userData
// path is handed down by the main process via `FOVEA_DATA_PATH`.
//
// Writes are atomic (temp file + rename) and operations on the same file are
// serialized, so rapid edits (e.g. dragging the exposure slider) can never tear
// a concurrent read or lose a read-modify-write.

import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { replacer, reviver } from "@lib/store-codec";

const STORE = resolve(process.env.FOVEA_DATA_PATH ?? process.cwd(), "store");

function pathOf(segments: string | string[]): string {
  if (typeof segments === "string") segments = [segments];
  return resolve(STORE, ...segments) + ".json";
}

// Per-path FIFO so writes/updates to one file never overlap. One failed op does
// not break the chain. Entry count is bounded by the number of distinct files.
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, op: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(op, op);
  chains.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

async function readFileAs<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  const text = (await readFile(path)).toString();
  // Empty/truncated file (e.g. a leftover from a pre-atomic-write crash) → treat
  // as absent rather than a hard parse error.
  if (text.trim() === "") return fallback;
  try {
    return JSON.parse(text, reviver) as T;
  } catch (error) {
    process.stderr.write(`Error loading store ${path}: ${error}\n`);
    return fallback;
  }
}

let tmpSeq = 0;
async function atomicWrite(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
  await writeFile(tmp, JSON.stringify(data, replacer, 2));
  await rename(tmp, path); // atomic — readers see the old or new file, never empty
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Load a store entry, returning `fallback` when absent or unreadable. */
export function read<T>(segments: string | string[], fallback: T): Promise<T> {
  return readFileAs(pathOf(segments), fallback);
}

/** Replace a store entry (creating parent directories as needed). */
export function write(
  segments: string | string[],
  data: unknown,
): Promise<void> {
  const path = pathOf(segments);
  return serialize(path, () => atomicWrite(path, data));
}

/** Merge a patch into a store entry as a serialized read-modify-write. */
export function update(
  segments: string | string[],
  patch: Record<string, unknown>,
): Promise<void> {
  const path = pathOf(segments);
  return serialize(path, async () => {
    const current = await readFileAs<Record<string, unknown>>(path, {});
    await atomicWrite(path, { ...current, ...patch });
  });
}

/** Delete a store entry (no-op if absent). */
export function clear(segments: string | string[]): Promise<void> {
  const path = pathOf(segments);
  return serialize(path, () => rm(path, { force: true }));
}

/** List entry names (without `.json`) under a store directory. */
export async function list(...segments: string[]): Promise<string[]> {
  const dir = resolve(STORE, ...segments);
  if (!existsSync(dir) || !(await isDirectory(dir))) return [];
  const entries = await readdir(dir);
  const names = await Promise.all(
    entries.map(async (e) =>
      (await isDirectory(resolve(dir, e))) ? null : e.replace(/\.json$/, ""),
    ),
  );
  return names.filter((n): n is string => n !== null);
}
