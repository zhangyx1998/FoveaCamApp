// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer-side config store client. Same public shape (open/clear/list/read) but the
// transport targets MAIN (the single config authority) over window.foveaBridge
// (ipcRenderer), not the orchestrator channel — so it outlives any orchestrator
// instance and sends key-level PATCHes (concurrent edits to different keys don't
// clobber). open() returns a Vue-reactive object; cross-window edits arrive as
// store:changed and apply onto the same reference under the `applying` guard.
// spec: docs/spec/store.md#store-client

import { reactive, toRaw, watch } from "vue";
import { diffKeys, replaceInPlace, type PatchOp } from "./store-patch.js";
import { wireDecode, wireEncode } from "./store-codec.js";

const keyOf = (segments: string | string[]) =>
  (typeof segments === "string" ? [segments] : segments).join("/");

/** Deep snapshot of a tracked doc — the "last value main acked" that future
 *  diffs are computed against. `toRaw` first so `structuredClone` sees the plain
 *  underlying object, not the Vue reactive Proxy (which `structuredClone` refuses
 *  to clone). Config values are structured-clone-safe (bigint/Date/TypedArray
 *  included), so no codec is needed. */
function snapshot<T>(value: T): T {
  return structuredClone(toRaw(value as object)) as T;
}

// One process-wide dispatcher for `store:changed` pushes: main sends (path,
// value); we route to the per-key applier registered by `open()`. Registered
// lazily on first `open()` so a renderer that never opens a store adds no
// listener.
const appliers = new Map<string, (value: unknown) => void>();
let changedWired = false;
function ensureChangedWired(): void {
  if (changedWired) return;
  changedWired = true;
  // Values arrive WIRE-ENCODED (codec-JSON): bare structured clone strips
  // TypedArray expando props (a Mat's `shape`) — see store-codec wire framing.
  window.foveaBridge.onStoreChanged((path, value) =>
    appliers.get(keyOf(path))?.(wireDecode(value as string)),
  );
}

export default class Store {
  private static readonly registry = new Map<string, WeakRef<object>>();
  private static readonly origins = new WeakMap<object, string[]>();

  static async open<
    T extends object,
    R extends object = T extends Array<infer _> ? T : Partial<T>,
  >(segments: string | string[], fallback: R = {} as R): Promise<R> {
    const path = typeof segments === "string" ? [segments] : segments;
    const key = keyOf(path);
    const entry = this.registry.get(key);
    if (entry) {
      const cached = entry.deref();
      if (cached !== undefined) return cached as R;
      this.registry.delete(key);
    }

    ensureChangedWired();
    const initial = wireDecode<R>(
      await window.foveaBridge.readStore<string>(path, wireEncode(fallback)),
    );
    const tracked = reactive(initial) as R;

    // The last document value main has acknowledged — every local patch is a diff
    // against this. Seeded with the initial read; advanced on each ack and on each
    // incoming change from another window.
    let acked = snapshot(initial) as R;

    // Guards the incoming-change path from re-triggering the write queue it is
    // applying — an echo isn't a new local edit.
    let applying = false;
    let writePending = false;
    const queueWrite = () => {
      if (applying || writePending) return;
      writePending = true;
      // `queueMicrotask`, not `process.nextTick` — bare `process` isn't defined
      // in an isolated renderer; microtask timing is equivalent for this debounce.
      queueMicrotask(() => {
        writePending = false;
        const ops: PatchOp[] = diffKeys(tracked, acked);
        if (ops.length === 0) return; // no-op edit → no patch
        acked = snapshot(tracked) as R; // optimistic; a concurrent change reconciles below
        void window.foveaBridge.patchStore(path, wireEncode(ops));
      });
    };
    watch(() => tracked, queueWrite, { deep: true });

    appliers.set(key, (value: unknown) => {
      applying = true;
      try {
        replaceInPlace(tracked, value);
        acked = snapshot(tracked) as R;
      } finally {
        applying = false;
      }
    });

    this.registry.set(key, new WeakRef(tracked));
    this.origins.set(tracked, path);
    return tracked as R;
  }

  static clear(store: object): Promise<void>;
  static clear(...segments: string[]): Promise<void>;
  static async clear(seg: string | object, ...segments: string[]): Promise<void> {
    const path = typeof seg === "object" ? this.origins.get(seg) : [seg, ...segments];
    if (!path) {
      console.error("Object is not a store instance:", seg);
      throw new Error("Object is not a store instance");
    }
    const entry = this.registry.get(keyOf(path))?.deref();
    if (entry) for (const k of Object.keys(entry)) delete (entry as any)[k];
    await window.foveaBridge.clearStore(path);
  }

  static async list(...segments: string[]): Promise<string[]> {
    return window.foveaBridge.listStore(segments);
  }

  /** One-shot read of a document WITHOUT subscribing to future writes — the
   *  enumeration primitive (config window's calibration-data manager reads many
   *  docs just for metadata, and must not leave a live listener on each). Unlike
   *  `open()` this returns a plain snapshot, not a tracked reactive object. */
  static async read<T>(segments: string | string[], fallback: T): Promise<T> {
    const path = typeof segments === "string" ? [segments] : segments;
    return wireDecode<T>(
      await window.foveaBridge.readStoreOnce<string>(path, wireEncode(fallback)),
    );
  }
}
