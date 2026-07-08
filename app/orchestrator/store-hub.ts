// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Store hub: the single write/broadcast path for every persisted config
// document, whether the write originates from an orchestrator-internal
// session (manage-cameras persisting a slider drag) or a renderer `Store`
// client (docs/history/refactor/async-reactive.md). Wraps the fs primitives in
// `./store.ts` with a per-path in-memory cache and change notification, so
// every reader — regardless of process or origin — sees the same value and
// the same write order. This retires the config dual-ownership hotspot noted
// in docs/history/refactor/orchestrator.md §4 (same bug class as the camera
// registry: two independent writers racing the same on-disk file).
//
// `attachStore(ch)` wires one renderer `Channel` to this cache: `store:read`
// both returns the current value and remembers this channel's interest in
// that path (registering a listener that forwards future writes on
// `store:${path}`); `store:write`/`store:clear` persist through here so
// every other interested channel (and any internal session using `write`/
// `update` directly) gets notified. Passing that channel's own listener as
// `except` on its own writes mirrors `ServerSession.setState`'s originating-
// channel echo-skip (§12.1 C8) — an optimistic local write shouldn't round-
// trip back and risk clobbering a newer local edit.

import type { Channel } from "../lib/orchestrator/protocol.js";
import * as fs from "./store.js";

type Listener = (value: unknown) => void;
type Path = string | string[];

interface Doc {
  value: unknown;
  loaded: boolean;
  op: Promise<void>;
  readonly listeners: Set<Listener>;
}

const docs = new Map<string, Doc>();
const keyOf = (segments: Path) =>
  (typeof segments === "string" ? [segments] : segments).join("/");

// Perf substrate (docs/history/refactor/orchestrator.md §7.3 item 4) — cumulative
// counts for `system.perfSnapshot`, regardless of whether the write came
// from a renderer's `Store` client or an internal session.
const counts = { writes: 0, updates: 0, clears: 0 };
export function writeCounts(): Readonly<typeof counts> {
  return counts;
}

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

function notify(doc: Doc, value: unknown, except?: Listener): void {
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

/** Read a document, populating the cache from disk on first access. */
export async function read<T>(segments: Path, fallback: T): Promise<T> {
  const doc = docFor(segments);
  return enqueue(doc, async () => {
    if (!doc.loaded) {
      doc.value = await fs.read(segments, fallback);
      doc.loaded = true;
    }
    return doc.value as T;
  });
}

/** Replace a document, persist, and notify every listener but `except`. */
export async function write(
  segments: Path,
  value: unknown,
  except?: Listener,
): Promise<void> {
  const doc = docFor(segments);
  await enqueue(doc, async () => {
    doc.value = value;
    doc.loaded = true;
    await fs.write(segments, value);
    counts.writes++;
    notify(doc, value, except);
  });
}

/** Merge a patch as a read-modify-write, persist, and notify (same
 *  echo-skip as `write`). */
export async function update(
  segments: Path,
  patch: Record<string, unknown>,
  except?: Listener,
): Promise<void> {
  const doc = docFor(segments);
  await enqueue(doc, async () => {
    if (!doc.loaded) {
      doc.value = await fs.read(segments, {});
      doc.loaded = true;
    }
    const value = { ...(doc.value as Record<string, unknown>), ...patch };
    doc.value = value;
    await fs.write(segments, value);
    counts.updates++;
    notify(doc, value, except);
  });
}

export async function clear(segments: Path): Promise<void> {
  const doc = docFor(segments);
  await enqueue(doc, async () => {
    doc.value = undefined;
    doc.loaded = false;
    await fs.clear(segments);
    counts.clears++;
    notify(doc, undefined);
  });
}

export function list(...segments: string[]): Promise<string[]> {
  return fs.list(...segments);
}

/** Attach one renderer channel to the store RPC surface. Returns a detach
 *  callback (call on channel close) that unsubscribes every path this
 *  channel opened. */
export function attachStore(ch: Channel): () => void {
  // Per-path listener this channel registered — needed both to unsubscribe
  // on detach and to pass as `except` on this channel's own writes.
  const listeners = new Map<string, Listener>();

  ch.handle("store:read", async ({ path, fallback }: { path: string[]; fallback: unknown }) => {
    const key = keyOf(path);
    if (!listeners.has(key)) {
      const listener: Listener = (value) => ch.emit(`store:${key}`, value);
      listeners.set(key, listener);
      docFor(path).listeners.add(listener);
    }
    return read(path, fallback);
  });

  ch.handle("store:write", ({ path, value }: { path: string[]; value: unknown }) =>
    write(path, value, listeners.get(keyOf(path))),
  );

  ch.handle("store:clear", ({ path }: { path: string[] }) => clear(path));

  ch.handle("store:list", ({ path }: { path: string[] }) => list(...path));

  return () => {
    for (const [key, listener] of listeners) docs.get(key)?.listeners.delete(listener);
    listeners.clear();
  };
}
