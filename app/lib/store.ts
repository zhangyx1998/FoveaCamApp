// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer-side config store client. Same public shape as the old direct-fs
// `Store` (`open`/`clear`/`list`) so every existing consumer (camera.ts,
// config.ts, calibrate-extrinsic) keeps working unchanged, but every read and
// write now goes through the orchestrator's `store-hub` instead of touching
// disk from the renderer directly. This retires the renderer/orchestrator
// config dual-ownership hotspot (docs/history/refactor/orchestrator.md §4,
// docs/history/refactor/async-reactive.md) — there is exactly one process writing
// these files now, whichever window last edited it, and it's not this one.
//
// `open()` still returns a plain Vue-reactive object a module mutates
// directly (`config.role = "L"`); any deep mutation queues a whole-document
// write to the orchestrator on the next tick (same debounce as before). A
// write from another window (or an orchestrator-internal session, e.g.
// manage-cameras persisting a slider drag) applies onto the same object
// reference via the `applying` guard below, so anything already depending on
// it (templates, computed values) updates for free without a new subscribe.
//
// Values cross the wire via `Channel`'s structured-clone transport, not JSON
// — bigint/Date/TypedArray survive natively, so unlike the old on-disk
// format (`store-codec.ts`, still used orchestrator-side for the JSON file
// itself) no codec is needed here.

import { reactive, watch } from "vue";
import { connect } from "./orchestrator/client.js";

const keyOf = (segments: string | string[]) =>
  (typeof segments === "string" ? [segments] : segments).join("/");

/** Reconcile `target`'s keys/values to match `value` without replacing the
 *  object reference — callers hold onto `target` directly. */
function replaceInPlace(target: any, value: any): void {
  if (Array.isArray(target) && Array.isArray(value)) {
    target.length = 0;
    target.push(...value);
    return;
  }
  for (const k of Object.keys(target)) if (!(k in value)) delete target[k];
  Object.assign(target, value);
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

    const ch = await connect();
    const initial = await ch.request<R>("store:read", { path, fallback });
    const tracked = reactive(initial) as R;

    // Guards the server-echo path below from re-triggering the write queue
    // it's applying — an echo isn't a new local edit.
    let applying = false;
    let writePending = false;
    const queueWrite = () => {
      if (applying || writePending) return;
      writePending = true;
      // `queueMicrotask`, not `process.nextTick` — bare `process` isn't
      // defined in an isolated renderer without `nodeIntegration`
      // (docs/history/refactor/orchestrator.md §7.1 T5); microtask timing is
      // equivalent for this debounce (both drain before the next macrotask).
      queueMicrotask(() => {
        writePending = false;
        void ch.request("store:write", { path, value: tracked });
      });
    };
    watch(() => tracked, queueWrite, { deep: true });
    ch.on(`store:${key}`, (value: R) => {
      applying = true;
      try {
        replaceInPlace(tracked, value);
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
    const ch = await connect();
    await ch.request("store:clear", { path });
  }

  static async list(...segments: string[]): Promise<string[]> {
    const ch = await connect();
    return ch.request<string[]>("store:list", { path: segments });
  }
}
