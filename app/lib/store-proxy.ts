// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Client-side proxy over the MAIN config-store authority, used by the orchestrator + probe
// processes via their parentPort. Exposes the exact store-hub API but every op is a
// store:req to main (correlated by id to a store:res); main pushes store:changed for every
// subscribed path so this process's subscribe() listeners fire on ANY window's edit, cross-
// instance. A mutating op caches + notifies the VALUE main returns (main skips echoing to
// the originator, so an own write persists + updates local subscribers with no double-fire).
// spec: docs/spec/store.md#store-proxy

import { wireDecode, wireEncode } from "./store-codec.js";

export type Path = string | string[];
export type StoreProxyListener = (value: unknown) => void;
export type StoreReqOp = "read" | "read-once" | "write" | "update" | "clear" | "list";

/** child → main. Value-bearing fields are WIRE-ENCODED codec-JSON strings
 *  (`wireEncode`) — bare structured clone strips TypedArray expando props
 *  (a Mat's `shape`); see store-codec's wire-framing note. */
export interface StoreReqMessage {
  type: "store:req";
  reqId: number;
  op: StoreReqOp;
  path: string[];
  /** wire-encoded */
  fallback?: string;
  /** wire-encoded */
  value?: string;
  /** wire-encoded Record<string, unknown> */
  patch?: string;
}
export interface StoreSubscribeMessage {
  type: "store:subscribe";
  path: string[];
}
export type StoreClientMessage = StoreReqMessage | StoreSubscribeMessage;

/** main → child */
export interface StoreResMessage {
  type: "store:res";
  reqId: number;
  ok: boolean;
  /** wire-encoded */
  value?: string;
  error?: string;
}
export interface StoreChangedMessage {
  type: "store:changed";
  path: string[];
  /** wire-encoded */
  value: string;
}
export type StoreServerMessage = StoreResMessage | StoreChangedMessage;

export interface StoreProxyTransport {
  post(msg: StoreClientMessage): void;
  /** Register the server-message sink. Implementations MUST filter for the two
   *  store server types and ignore everything else (the orchestrator shares one
   *  `parentPort` with its control-message handler). */
  onMessage(cb: (msg: StoreServerMessage) => void): void;
}

export interface StoreProxy {
  read<T>(segments: Path, fallback: T): Promise<T>;
  write(segments: Path, value: unknown): Promise<void>;
  update(segments: Path, patch: Record<string, unknown>): Promise<void>;
  clear(segments: Path): Promise<void>;
  list(...segments: string[]): Promise<string[]>;
  subscribe(segments: Path, listener: StoreProxyListener): () => void;
  counts(): Readonly<{ writes: number; updates: number; clears: number }>;
}

const asArray = (segments: Path): string[] =>
  typeof segments === "string" ? [segments] : segments;
const keyOf = (segments: Path): string => asArray(segments).join("/");

interface ProxyDoc {
  value: unknown;
  loaded: boolean;
  subscribed: boolean;
  readonly listeners: Set<StoreProxyListener>;
}

export function createStoreProxy(transport: StoreProxyTransport): StoreProxy {
  const docs = new Map<string, ProxyDoc>();
  const counts = { writes: 0, updates: 0, clears: 0 };
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let seq = 0;

  transport.onMessage((msg) => {
    if (msg.type === "store:res") {
      const w = pending.get(msg.reqId);
      if (!w) return;
      pending.delete(msg.reqId);
      if (msg.ok) w.resolve(wireDecode(msg.value));
      else w.reject(new Error(msg.error ?? "store authority error"));
    } else if (msg.type === "store:changed") {
      const doc = docs.get(keyOf(msg.path));
      if (!doc) return;
      const value = wireDecode(msg.value);
      doc.value = value;
      doc.loaded = true;
      for (const fn of doc.listeners) fn(value);
    }
  });

  function docFor(segments: Path): ProxyDoc {
    const key = keyOf(segments);
    let doc = docs.get(key);
    if (!doc)
      docs.set(
        key,
        (doc = { value: undefined, loaded: false, subscribed: false, listeners: new Set() }),
      );
    return doc;
  }

  function ensureSubscribed(segments: Path): ProxyDoc {
    const doc = docFor(segments);
    if (!doc.subscribed) {
      doc.subscribed = true;
      transport.post({ type: "store:subscribe", path: asArray(segments) });
    }
    return doc;
  }

  function request(op: StoreReqOp, extra: Partial<StoreReqMessage>): Promise<unknown> {
    const reqId = ++seq;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      transport.post({ type: "store:req", reqId, op, path: [], ...extra } as StoreReqMessage);
    });
  }

  function notify(doc: ProxyDoc, value: unknown): void {
    for (const fn of doc.listeners) fn(value);
  }

  return {
    async read<T>(segments: Path, fallback: T): Promise<T> {
      const doc = ensureSubscribed(segments);
      const value = (await request("read", {
        path: asArray(segments),
        fallback: wireEncode(fallback),
      })) as T;
      doc.value = value;
      doc.loaded = true;
      return value;
    },
    async write(segments: Path, value: unknown): Promise<void> {
      const doc = docFor(segments);
      const result = await request("write", {
        path: asArray(segments),
        value: wireEncode(value),
      });
      doc.value = result;
      doc.loaded = true;
      counts.writes++;
      notify(doc, result);
    },
    async update(segments: Path, patch: Record<string, unknown>): Promise<void> {
      const doc = docFor(segments);
      const result = await request("update", {
        path: asArray(segments),
        patch: wireEncode(patch),
      });
      doc.value = result;
      doc.loaded = true;
      counts.updates++;
      notify(doc, result);
    },
    async clear(segments: Path): Promise<void> {
      const doc = docFor(segments);
      await request("clear", { path: asArray(segments) });
      doc.value = undefined;
      doc.loaded = false;
      counts.clears++;
      notify(doc, undefined);
    },
    list(...segments: string[]): Promise<string[]> {
      return request("list", { path: segments }) as Promise<string[]>;
    },
    subscribe(segments: Path, listener: StoreProxyListener): () => void {
      const doc = ensureSubscribed(segments);
      doc.listeners.add(listener);
      return () => {
        doc.listeners.delete(listener);
      };
    },
    counts: () => counts,
  };
}
