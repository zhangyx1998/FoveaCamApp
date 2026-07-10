// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// MAIN is the single config-store authority (docs/proposals/config-store-main-
// authority.md). This wires the transport-free `StoreAuthority` core to the two
// client transports:
//   • renderer windows  — over ipcMain (structured clone; bigint/Date/TypedArray
//     survive). `Store` (app/lib/store.ts) reads (subscribing), patches, clears,
//     lists, and read-onces. Each interested webContents gets ONE authority
//     listener per path that pushes `store:changed`; the originator of a patch is
//     never echoed its own change. Subscriptions self-clean on `destroyed`.
//   • orchestrator instances + the probe — over each child's `parentPort`, via
//     the `store:req`/`store:res` + `store:changed` protocol in
//     `@lib/store-proxy`. `attachProcess` returns a message handler main routes
//     the child's `store:*` messages into, and a `detach` for process exit.
//
// The fs backend is `app/orchestrator/store.ts` reused verbatim (same on-disk
// JSON codec + layout — zero migration); its store root reads `FOVEA_DATA_PATH`
// lazily, which main sets at body top.

import type { WebContents } from "electron";
import {
  createStoreAuthority,
  keyOf,
  type StoreFsBackend,
  type StoreListener,
} from "@lib/store-authority";
import type { PatchOp } from "@lib/store-patch";
import type {
  StoreClientMessage,
  StoreServerMessage,
} from "@lib/store-proxy";
import * as fsStore from "../orchestrator/store.js";

/** Push a `store:changed` to one renderer window (path + full value). Injected
 *  so main reuses its guarded `pushTo` (drops on a dying webContents). */
export type SendChanged = (wc: WebContents, path: string[], value: unknown) => void;

interface ClientSubs {
  readonly subs: Map<string, { listener: StoreListener; unsub: () => void }>;
}

export class StoreMain {
  private readonly authority;
  private readonly renderers = new Map<number, ClientSubs>();

  /** `fs` defaults to the real store fs primitives; injected in unit tests. */
  constructor(
    private readonly sendChanged: SendChanged,
    fs: StoreFsBackend = fsStore,
  ) {
    this.authority = createStoreAuthority(fs);
  }

  // ---- Renderer (ipcMain) surface -----------------------------------------

  /** Read a doc AND subscribe this window to future changes (the `Store.open`
   *  primitive). */
  read(wc: WebContents, path: string[], fallback: unknown): Promise<unknown> {
    this.rendererListener(wc, path); // registers interest
    return this.authority.read(path, fallback);
  }

  /** One-shot read WITHOUT subscribing (the enumeration primitive). */
  readOnce(path: string[], fallback: unknown): Promise<unknown> {
    return this.authority.read(path, fallback);
  }

  /** Merge a key-level patch and broadcast to every OTHER subscriber. Returns
   *  the merged document (the origin window reconciles its last-acked snapshot
   *  against it). */
  patch(wc: WebContents, path: string[], ops: readonly PatchOp[]): Promise<unknown> {
    return this.authority.patch(path, ops, this.rendererListener(wc, path));
  }

  clear(wc: WebContents, path: string[]): Promise<void> {
    return this.authority.clear(path, this.originListener(wc, path)).then(() => undefined);
  }

  list(path: string[]): Promise<string[]> {
    return this.authority.list(...path);
  }

  /** Drop every subscription a closed window held. */
  dropRenderer(wcId: number): void {
    const client = this.renderers.get(wcId);
    if (!client) return;
    for (const { unsub } of client.subs.values()) unsub();
    this.renderers.delete(wcId);
  }

  /** The stable listener for (window, path) — memoized so it can be passed as
   *  `except` on that window's own writes (echo-skip). Auto-cleans on the
   *  window's `destroyed`. */
  private rendererListener(wc: WebContents, path: string[]): StoreListener {
    let client = this.renderers.get(wc.id);
    if (!client) {
      client = { subs: new Map() };
      this.renderers.set(wc.id, client);
      wc.once("destroyed", () => this.dropRenderer(wc.id));
    }
    const key = keyOf(path);
    let entry = client.subs.get(key);
    if (!entry) {
      const listener: StoreListener = (value) => this.sendChanged(wc, path, value);
      entry = { listener, unsub: this.authority.subscribe(path, listener) };
      client.subs.set(key, entry);
    }
    return entry.listener;
  }

  /** The existing listener for (window, path) without creating one — used as
   *  `except` on `clear`, where a window that never subscribed simply has no
   *  echo to skip. */
  private originListener(wc: WebContents, path: string[]): StoreListener | undefined {
    return this.renderers.get(wc.id)?.subs.get(keyOf(path))?.listener;
  }

  // ---- Child-process (parentPort) surface ---------------------------------

  /** Attach one child process (an orchestrator instance or the probe). `send`
   *  posts a server message to the child's `parentPort`. Returns the handler for
   *  the child's `store:*` messages + a `detach` to call on the child's exit. */
  attachProcess(send: (msg: StoreServerMessage) => void): {
    handleMessage: (msg: StoreClientMessage) => void;
    detach: () => void;
  } {
    const subs = new Map<string, { listener: StoreListener; unsub: () => void }>();
    const ensureSub = (path: string[]): StoreListener => {
      const key = keyOf(path);
      let entry = subs.get(key);
      if (!entry) {
        const listener: StoreListener = (value) =>
          send({ type: "store:changed", path, value });
        entry = { listener, unsub: this.authority.subscribe(path, listener) };
        subs.set(key, entry);
      }
      return entry.listener;
    };

    const handleMessage = (msg: StoreClientMessage): void => {
      if (msg.type === "store:subscribe") {
        ensureSub(msg.path);
        return;
      }
      if (msg.type !== "store:req") return;
      const { reqId, op, path } = msg;
      // A child never receives a broadcast for its OWN write — pass its own
      // listener (if it has one) as `except`.
      const except = subs.get(keyOf(path))?.listener;
      const run = async (): Promise<unknown> => {
        switch (op) {
          case "read":
            ensureSub(path);
            return this.authority.read(path, msg.fallback);
          case "read-once":
            return this.authority.read(path, msg.fallback);
          case "write":
            return this.authority.write(path, msg.value, except);
          case "update":
            return this.authority.update(path, msg.patch ?? {}, except);
          case "clear":
            return this.authority.clear(path, except);
          case "list":
            return this.authority.list(...path);
          default:
            throw new Error(`unknown store op: ${String(op)}`);
        }
      };
      run().then(
        (value) => send({ type: "store:res", reqId, ok: true, value }),
        (error) => send({ type: "store:res", reqId, ok: false, error: String(error) }),
      );
    };

    const detach = (): void => {
      for (const { unsub } of subs.values()) unsub();
      subs.clear();
    };

    return { handleMessage, detach };
  }
}
