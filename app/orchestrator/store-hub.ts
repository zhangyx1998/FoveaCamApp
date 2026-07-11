// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator-side config-store client: a thin proxy over the instance's parentPort
// to the single MAIN authority, preserving the exact prior public API and reactive
// semantics (subscribe now fires cross-instance; local-apply avoids double-echo).
// Falls back to a local fs authority only when no parentPort exists (unit tests).
// spec: docs/spec/store.md#store-hub

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
