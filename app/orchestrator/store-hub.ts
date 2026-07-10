// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator-side config-store client. The single authority now lives in MAIN
// (docs/proposals/config-store-main-authority.md) — this module is a THIN PROXY
// over the instance's `parentPort` that preserves the EXACT public API every
// orchestrator-internal caller relied on (`read`/`write`/`update`/`clear`/
// `list`/`subscribe`/`writeCounts`) and their reactive semantics: a `subscribe()`
// listener still fires on ANY window's edit, now including a window on a DIFFERENT
// orchestrator instance (the old per-process hub could not see across instances —
// defect D1). `write`/`update`/`clear` forward to main and locally apply the
// value main returns, so this process's own subscribers (anaglyph-style retune,
// etc.) update without a double-echo (main skips the originator).
//
// `attachStore` is GONE: renderer `Store` clients now talk to main directly
// (ipcRenderer), not through the orchestrator channel, so there is no renderer
// store RPC to wire onto a `Channel` here anymore.
//
// Transport: this process shares its one `parentPort` with `index.ts`'s control-
// message handler; the proxy adds its own `message` listener and filters for
// `store:res`/`store:changed` only. When NO `parentPort` exists (unit tests /
// non-utility contexts) it falls back to a LOCAL authority over `./store.ts`'s fs
// primitives — production store-writing processes (orchestrator instances, the
// probe) always have a `parentPort`, so that fallback never runs at runtime.

import {
  createStoreProxy,
  type StoreProxy,
  type StoreProxyTransport,
  type StoreServerMessage,
} from "@lib/store-proxy";
import { createStoreAuthority } from "@lib/store-authority";
import * as fs from "./store.js";

type ParentPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): void;
};

/** Wrap the utilityProcess `parentPort` as a store-proxy transport. Filters the
 *  shared message stream down to the two store server types. */
function parentPortTransport(port: ParentPort): StoreProxyTransport {
  return {
    post: (msg) => port.postMessage(msg),
    onMessage: (cb) =>
      port.on("message", (e) => {
        const data = e.data as { type?: string } | null;
        if (data && (data.type === "store:res" || data.type === "store:changed"))
          cb(data as StoreServerMessage);
      }),
  };
}

/** Local-authority fallback shaped as a `StoreProxy` (see the file header — unit
 *  tests only). Discards the value the authority returns to match the proxy's
 *  `Promise<void>` write/update/clear signatures. */
function localBackend(): StoreProxy {
  const auth = createStoreAuthority(fs);
  return {
    read: auth.read,
    write: (s, v) => auth.write(s, v).then(() => undefined),
    update: (s, p) => auth.update(s, p).then(() => undefined),
    clear: (s) => auth.clear(s).then(() => undefined),
    list: auth.list,
    subscribe: auth.subscribe,
    counts: auth.counts,
  };
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
const backend: StoreProxy = parentPort
  ? createStoreProxy(parentPortTransport(parentPort))
  : localBackend();

/** Read a document (subscribing this process to future changes so the cache
 *  stays fresh across cross-window edits). */
export const read = backend.read;
/** Replace a document (whole-doc), persist through main, notify local subscribers. */
export const write = backend.write;
/** Merge a set-patch into a document (read-modify-write in main), notify local. */
export const update = backend.update;
/** Delete a document, notify local subscribers with `undefined`. */
export const clear = backend.clear;
/** List entry names under a store directory. */
export const list = backend.list;
/** Subscribe an orchestrator-internal listener to a document's writes — fires on
 *  every write/update/clear from ANY window or process (main broadcast), minus
 *  this process's own origin skip. Does NOT populate the cache — pair with
 *  `read` for the initial value. */
export const subscribe = backend.subscribe;

/** Cumulative write/update/clear counts for this process (perf substrate). */
export function writeCounts(): Readonly<{ writes: number; updates: number; clears: number }> {
  return backend.counts();
}
