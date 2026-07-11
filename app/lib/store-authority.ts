// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The single config-store authority core: a transport-free cache/serialize/notify engine
// (per-path in-memory cache, per-document serialized op queue so broadcasts never reflect
// uncommitted values and concurrent writes never tear, notify-except-origin). The fs
// backend is INJECTED so it's unit-testable and the one real instance lives in MAIN. Every
// mutating op returns the RESULTING document value so a proxy caches/notifies exactly what
// was persisted; `patch` is the key-level merge the renderer client drives.
// spec: docs/spec/store.md#store-authority

import { applyOps, type PatchOp } from "./store-patch.js";

export type Path = string | string[];
export type StoreListener = (value: unknown) => void;

/** The disk-facing primitives the authority persists through. Satisfied by
 *  `app/orchestrator/store.ts` (JSON files under `<FOVEA_DATA_PATH>/store`). */
export interface StoreFsBackend {
  read<T>(segments: string[], fallback: T): Promise<T>;
  write(segments: string[], value: unknown): Promise<void>;
  clear(segments: string[]): Promise<void>;
  list(...segments: string[]): Promise<string[]>;
}

interface Doc {
  value: unknown;
  loaded: boolean;
  op: Promise<void>;
  readonly listeners: Set<StoreListener>;
}

export interface StoreAuthority {
  read<T>(segments: Path, fallback: T): Promise<T>;
  write(segments: Path, value: unknown, except?: StoreListener): Promise<unknown>;
  update(
    segments: Path,
    patch: Record<string, unknown>,
    except?: StoreListener,
  ): Promise<unknown>;
  patch(segments: Path, ops: readonly PatchOp[], except?: StoreListener): Promise<unknown>;
  clear(segments: Path, except?: StoreListener): Promise<unknown>;
  list(...segments: string[]): Promise<string[]>;
  subscribe(segments: Path, listener: StoreListener): () => void;
  /** Cumulative write/update/clear counts (perf substrate) since creation. */
  counts(): Readonly<{ writes: number; updates: number; clears: number }>;
}

const asArray = (segments: Path): string[] =>
  typeof segments === "string" ? [segments] : segments;
export const keyOf = (segments: Path): string => asArray(segments).join("/");

export function createStoreAuthority(fs: StoreFsBackend): StoreAuthority {
  const docs = new Map<string, Doc>();
  const counts = { writes: 0, updates: 0, clears: 0 };

  function docFor(segments: Path): Doc {
    const key = keyOf(segments);
    let doc = docs.get(key);
    if (!doc)
      docs.set(
        key,
        (doc = {
          value: undefined,
          loaded: false,
          op: Promise.resolve(),
          listeners: new Set(),
        }),
      );
    return doc;
  }

  function notify(doc: Doc, value: unknown, except?: StoreListener): void {
    for (const fn of doc.listeners) if (fn !== except) fn(value);
  }

  function enqueue<T>(doc: Doc, op: () => Promise<T>): Promise<T> {
    const run = doc.op.then(op, op);
    doc.op = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function read<T>(segments: Path, fallback: T): Promise<T> {
    const doc = docFor(segments);
    return enqueue(doc, async () => {
      if (!doc.loaded) {
        doc.value = await fs.read(asArray(segments), fallback);
        doc.loaded = true;
      }
      return doc.value as T;
    });
  }

  async function write(
    segments: Path,
    value: unknown,
    except?: StoreListener,
  ): Promise<unknown> {
    const doc = docFor(segments);
    return enqueue(doc, async () => {
      doc.value = value;
      doc.loaded = true;
      await fs.write(asArray(segments), value);
      counts.writes++;
      notify(doc, value, except);
      return value;
    });
  }

  async function update(
    segments: Path,
    patch: Record<string, unknown>,
    except?: StoreListener,
  ): Promise<unknown> {
    const doc = docFor(segments);
    return enqueue(doc, async () => {
      if (!doc.loaded) {
        doc.value = await fs.read(asArray(segments), {});
        doc.loaded = true;
      }
      const value = { ...(doc.value as Record<string, unknown>), ...patch };
      doc.value = value;
      await fs.write(asArray(segments), value);
      counts.updates++;
      notify(doc, value, except);
      return value;
    });
  }

  async function patch(
    segments: Path,
    ops: readonly PatchOp[],
    except?: StoreListener,
  ): Promise<unknown> {
    const doc = docFor(segments);
    return enqueue(doc, async () => {
      if (!doc.loaded) {
        doc.value = await fs.read(asArray(segments), {});
        doc.loaded = true;
      }
      const value = applyOps(doc.value, ops);
      doc.value = value;
      await fs.write(asArray(segments), value);
      counts.writes++;
      notify(doc, value, except);
      return value;
    });
  }

  async function clear(segments: Path, except?: StoreListener): Promise<unknown> {
    const doc = docFor(segments);
    return enqueue(doc, async () => {
      doc.value = undefined;
      doc.loaded = false;
      await fs.clear(asArray(segments));
      counts.clears++;
      notify(doc, undefined, except);
      return undefined;
    });
  }

  function list(...segments: string[]): Promise<string[]> {
    return fs.list(...segments);
  }

  function subscribe(segments: Path, listener: StoreListener): () => void {
    const doc = docFor(segments);
    doc.listeners.add(listener);
    return () => {
      doc.listeners.delete(listener);
    };
  }

  return {
    read,
    write,
    update,
    patch,
    clear,
    list,
    subscribe,
    counts: () => counts,
  };
}
